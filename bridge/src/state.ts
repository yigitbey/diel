// Folds app-server events into one small snapshot the watch can render, and
// turns watch commands into app-server calls.

import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type { CodexClient, Json } from "./codex.ts";
import type { DesktopIpc } from "./desktop.ts";

export type Status = "offline" | "idle" | "working" | "needs-you" | "error";

export interface Snapshot {
  type: "state";
  status: Status;
  thread: { id: string; title: string } | null;
  activity: string;
  lastMessage: string;
  approval: { summary: string } | null;
  threads: { id: string; title: string }[];
  notice: string;
}

interface PendingApproval {
  rpcId: number | string;
  threadId: string;
  summary: string;
}

const MAX_MESSAGE = 600;
const POLL_MS = 3000;
// A thread someone else is running (e.g. the desktop app's own server) only
// shows up as a changing updatedAt. Treat it as busy for this long after a change.
const FOREIGN_BUSY_MS = 12_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const toMs = (t: unknown) => (typeof t === "number" ? (t > 1e12 ? t : t * 1000) : 0);

export function threadTitle(t: Json): string {
  const raw = t?.name || t?.title || t?.preview || "";
  return clip(oneLine(String(raw)) || "New thread", 40);
}

export function describeItem(item: Json): string {
  switch (item?.type) {
    case "commandExecution": {
      const cmd = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
      return clip(`Running ${oneLine(cmd)}`, 48);
    }
    case "fileChange": {
      const first = item.changes?.[0]?.path;
      const extra = (item.changes?.length ?? 0) > 1 ? ` +${item.changes.length - 1}` : "";
      return first ? clip(`Editing ${basename(first)}${extra}`, 48) : "Editing files";
    }
    case "reasoning":
      return "Thinking";
    case "webSearch":
      return clip(`Searching ${oneLine(String(item.query ?? "the web"))}`, 48);
    case "mcpToolCall":
      return clip(`Using ${item.tool ?? item.server ?? "a tool"}`, 48);
    case "agentMessage":
      return "Writing";
    case "plan":
      return "Planning";
    default:
      return "";
  }
}

function describeApproval(method: string, p: Json): string {
  if (method.includes("commandExecution")) {
    const cmd = Array.isArray(p.command) ? p.command.join(" ") : p.command;
    return clip(cmd ? `Run: ${oneLine(String(cmd))}` : p.reason || "Run a command", 120);
  }
  if (method.includes("fileChange")) return clip(p.reason || "Apply file changes", 120);
  return clip(p.reason || "Grant a permission", 120);
}

/**
 * Whether a turn read from stored history is still running. Codex stores an
 * unfinished turn as "interrupted" without completedAt; one that really was
 * interrupted looks the same, so that case only counts while `maybeLive`.
 */
export function turnRunning(turn: Json, maybeLive: boolean): boolean {
  if (turn.status === "inProgress") return true;
  return turn.status === "interrupted" && !turn.completedAt && maybeLive;
}

/** True when a thread changed in the last few minutes. */
function recentlyUpdated(thread: Json | undefined): boolean {
  return !!thread && Date.now() - toMs(thread.updatedAt) < 5 * 60_000;
}

function latestAgentText(turn: Json): string {
  const items: Json[] = turn.items ?? [];
  for (let j = items.length - 1; j >= 0; j--) if (items[j].type === "agentMessage" && items[j].text) return items[j].text;
  return "";
}

export interface AgentOptions {
  /** Working directory for threads created from the watch. */
  cwd: string;
  pollMs?: number;
  /** Route turns for threads the Codex desktop app has open through its IPC. */
  desktop?: DesktopIpc;
}

/** Emits "change" with a Snapshot whenever something the watch shows changed. */
export class Agent extends EventEmitter {
  private codex: CodexClient | null = null;
  private opts: AgentOptions;
  private threads: Json[] = [];
  private selectedId: string | null = null;
  private pinned = false; // true once the user picked a thread on the watch
  private wantNew = false; // next thing said starts a fresh thread
  private loaded = new Set<string>(); // threads this connection is subscribed to
  private activeTurn = new Map<string, string>(); // threadId -> turnId
  private serverStatus = new Map<string, Json>(); // threadId -> status object
  private lastChange = new Map<string, number>(); // threadId -> ms of last observed updatedAt change
  private seenUpdatedAt = new Map<string, number>();
  private activity = "";
  private lastMessage = "";
  private streaming = "";
  private failed = false;
  private notice = "";
  private approval: PendingApproval | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastSent = "";
  // Threads open in the desktop app can't be written by this app-server; their
  // turns go through the desktop app and their progress is read from history.
  private desktopTurn = new Map<string, string>(); // threadId -> turnId started via the desktop app
  private historyTurn = new Map<string, string>(); // threadId -> in-progress turnId seen in stored history

  constructor(opts: AgentOptions) {
    super();
    this.opts = opts;
  }

  /** Attach to a connected, not yet initialized client. */
  async attach(codex: CodexClient) {
    this.codex = codex;
    this.loaded.clear();
    this.activeTurn.clear();
    this.serverStatus.clear();
    this.approval = null;
    codex.on("notification", (m, p) => this.onNotification(m, p));
    codex.on("request", (id, m, p) => this.onRequest(id, m, p));
    codex.on("close", (why) => {
      if (this.codex !== codex) return;
      this.codex = null;
      this.notice = why;
      this.stopPolling();
      this.publish();
    });
    await codex.initialize();
    this.notice = "";
    await this.refreshThreads(true);
    this.timer = setInterval(() => this.refreshThreads().catch(() => {}), this.opts.pollMs ?? POLL_MS);
    this.publish();
  }

  /** Short explanation shown on the watch while offline. */
  setNotice(notice: string) {
    this.notice = notice;
    this.publish();
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- snapshot ----------------------------------------------------------

  snapshot(): Snapshot {
    const sel = this.threads.find((t) => t.id === this.selectedId) ?? null;
    return {
      type: "state",
      status: this.status(),
      thread: sel ? { id: sel.id, title: threadTitle(sel) } : null,
      activity: this.status() === "working" ? this.activity || "Working" : "",
      lastMessage: clip((this.streaming || this.lastMessage).trim(), MAX_MESSAGE),
      approval: this.approval ? { summary: this.approval.summary } : null,
      threads: this.threads.slice(0, 8).map((t) => ({ id: t.id, title: threadTitle(t) })),
      notice: this.notice,
    };
  }

  private status(): Status {
    if (!this.codex) return "offline";
    if (this.approval) return "needs-you";
    const id = this.selectedId;
    if (id) {
      const st = this.serverStatus.get(id);
      if (st?.type === "active" && st.activeFlags?.includes?.("waitingOnApproval")) return "needs-you";
      if (this.activeTurn.has(id) || this.desktopTurn.has(id) || this.historyTurn.has(id) || st?.type === "active") return "working";
      if (!this.loaded.has(id) && Date.now() - (this.lastChange.get(id) ?? 0) < FOREIGN_BUSY_MS) return "working";
      if (st?.type === "systemError") return "error";
    }
    return this.failed ? "error" : "idle";
  }

  private publish() {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.emit("change", snap);
  }

  // ---- thread list -------------------------------------------------------

  private async refreshThreads(first = false) {
    if (!this.codex) return;
    const res = await this.codex.request("thread/list", { limit: 20 });
    const list: Json[] = res?.data ?? res?.threads ?? [];
    list.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
    this.threads = list;

    for (const t of list) {
      if (t.status) this.serverStatus.set(t.id, t.status);
      const u = toMs(t.updatedAt);
      const prev = this.seenUpdatedAt.get(t.id);
      if (prev !== undefined && u > prev) this.lastChange.set(t.id, Date.now());
      this.seenUpdatedAt.set(t.id, u);
    }

    // Follow whichever thread was touched most recently, unless the user pinned one.
    const top = list[0]?.id ?? null;
    const previous = this.selectedId;
    if (!this.wantNew && (!this.pinned || !list.some((t) => t.id === this.selectedId))) {
      if (top !== this.selectedId) {
        this.selectedId = top;
        this.pinned = false;
      }
    }
    const sel = this.selectedId;
    const changed = sel !== previous;
    const foreignMoved =
      sel &&
      !this.loaded.has(sel) &&
      (this.desktopTurn.has(sel) || this.historyTurn.has(sel) || Date.now() - (this.lastChange.get(sel) ?? 0) < POLL_MS * 2);
    if (sel && (first || changed || foreignMoved)) await this.readLastMessage(sel).catch(() => {});
    this.publish();
  }

  /** Pull the newest agent message of a thread from its stored history. */
  private async readLastMessage(threadId: string) {
    if (!this.codex) return;
    const res = await this.codex.request("thread/read", { threadId, includeTurns: true });
    const turns: Json[] = res?.thread?.turns ?? [];
    let text = "";
    for (let i = turns.length - 1; i >= 0 && !text; i--) {
      const items: Json[] = turns[i].items ?? [];
      for (let j = items.length - 1; j >= 0; j--) {
        if (items[j].type === "agentMessage" && items[j].text) {
          text = items[j].text;
          break;
        }
      }
    }
    if (threadId !== this.selectedId) return;
    this.lastMessage = text;
    this.streaming = "";
    const last = turns.at(-1);
    this.failed = last?.status === "failed";
    if (this.loaded.has(threadId)) return; // live events cover threads this app-server runs

    // For threads run elsewhere, stored history is the only progress signal.
    // A turn still running elsewhere is stored as "interrupted" with no
    // completedAt, so only a completion time (or a final status) means done.
    const pending = this.desktopTurn.get(threadId);
    if (last && turnRunning(last, last.id === pending || recentlyUpdated(this.threads.find((t) => t.id === threadId)))) {
      this.historyTurn.set(threadId, last.id);
      const items: Json[] = last.items ?? [];
      this.activity = (items.length && describeItem(items[items.length - 1])) || "Working";
      // Don't present the previous turn's reply as the answer to this one.
      this.lastMessage = latestAgentText(last);
    } else {
      this.historyTurn.delete(threadId);
      // History says nothing is running, which beats guessing from updatedAt.
      this.lastChange.delete(threadId);
      // A turn just handed to the desktop app may not be in history yet.
      if (pending && turns.some((t) => t.id === pending && !turnRunning(t, true))) this.desktopTurn.delete(threadId);
      if (!this.desktopTurn.has(threadId)) this.activity = "";
      else this.lastMessage = "";
    }
  }

  /** Desktop app window that owns a thread, if any. */
  private async desktopOwner(threadId: string): Promise<string | null> {
    if (!this.opts.desktop || this.loaded.has(threadId)) return null;
    return this.opts.desktop.findOwner(threadId);
  }

  private async ensureLoaded(threadId: string) {
    if (this.loaded.has(threadId) || !this.codex) return;
    await this.codex.request("thread/resume", { threadId });
    this.loaded.add(threadId);
  }

  // ---- events from the app-server ---------------------------------------

  private onNotification(method: string, p: Json) {
    const threadId: string | undefined = p.threadId ?? p.thread?.id;
    const mine = !threadId || threadId === this.selectedId;
    switch (method) {
      case "thread/started":
        if (p.thread && !this.threads.some((t) => t.id === p.thread.id)) this.threads.unshift(p.thread);
        break;
      case "thread/status/changed":
        if (threadId) this.serverStatus.set(threadId, p.status);
        break;
      case "turn/started":
        if (threadId && p.turn?.id) this.activeTurn.set(threadId, p.turn.id);
        if (mine) {
          this.failed = false;
          this.activity = "Thinking";
          this.streaming = "";
        }
        break;
      case "turn/completed":
        if (threadId) this.activeTurn.delete(threadId);
        if (this.approval?.threadId === threadId) this.approval = null;
        if (mine) {
          this.activity = "";
          this.failed = p.turn?.status === "failed";
          if (this.failed && p.turn?.error?.message) this.lastMessage = String(p.turn.error.message);
          if (this.streaming) {
            this.lastMessage = this.streaming;
            this.streaming = "";
          }
        }
        break;
      case "item/started":
        if (mine) {
          const d = describeItem(p.item);
          if (d) this.activity = d;
          if (p.item?.type === "agentMessage") this.streaming = "";
        }
        break;
      case "item/agentMessage/delta":
        if (mine && typeof p.delta === "string") this.streaming += p.delta;
        break;
      case "item/completed":
        if (mine && p.item?.type === "agentMessage" && p.item.text) {
          this.lastMessage = p.item.text;
          this.streaming = "";
        }
        break;
      case "serverRequest/resolved":
        if (this.approval && (p.requestId === undefined || p.requestId === this.approval.rpcId)) this.approval = null;
        break;
      case "error":
        if (mine && p.error?.message && !p.willRetry) {
          this.failed = true;
          this.lastMessage = String(p.error.message);
        }
        break;
      default:
        return;
    }
    this.publish();
  }

  private onRequest(id: number | string, method: string, p: Json) {
    if (method.endsWith("/requestApproval")) {
      this.approval = { rpcId: id, threadId: p.threadId ?? this.selectedId ?? "", summary: describeApproval(method, p) };
      this.publish();
      return;
    }
    // Anything else (elicitations, user-input prompts) can't be answered from a
    // watch; refuse so the agent isn't left waiting forever.
    this.codex?.reject(id, `diel bridge does not handle ${method}`);
  }

  // ---- commands from the watch ------------------------------------------

  async say(text: string) {
    const codex = this.codex;
    text = text.trim();
    if (!codex) throw new Error("Agent is offline");
    if (!text) throw new Error("Nothing to send");

    if (!this.selectedId) {
      const res = await codex.request("thread/start", { cwd: this.opts.cwd });
      const thread = res.thread;
      this.loaded.add(thread.id);
      if (!this.threads.some((t) => t.id === thread.id)) this.threads.unshift(thread);
      this.selectedId = thread.id;
      this.wantNew = false;
    }
    const threadId = this.selectedId!;
    this.pinned = true;

    const owner = await this.desktopOwner(threadId);
    if (owner) {
      const desktop = this.opts.desktop!;
      const running = this.historyTurn.get(threadId) ?? this.desktopTurn.get(threadId);
      if (running) {
        try {
          await desktop.steerTurn(owner, threadId, text);
          return "steered";
        } catch {
          // The turn may have just finished; start a new one instead.
        }
      }
      const turnId = await desktop.startTurn(owner, threadId, text);
      this.desktopTurn.set(threadId, turnId ?? "pending");
      this.failed = false;
      this.activity = "Thinking";
      this.publish();
      return "started";
    }

    try {
      await this.ensureLoaded(threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("active writer")) throw new Error("This thread is open in the Codex app, which isn't accepting messages from the watch");
      throw e;
    }

    const input = [{ type: "text", text }];
    const running = this.activeTurn.get(threadId);
    if (running) {
      try {
        await codex.request("turn/steer", { threadId, input, expectedTurnId: running });
        return "steered";
      } catch {
        // The turn may have just finished; fall through and start a new one.
      }
    }
    const res = await codex.request("turn/start", { threadId, input });
    if (res?.turn?.id) this.activeTurn.set(threadId, res.turn.id);
    this.failed = false;
    this.activity = "Thinking";
    this.streaming = "";
    this.publish();
    return "started";
  }

  async stop() {
    const id = this.selectedId;
    if (id && !this.activeTurn.has(id)) {
      const owner = await this.desktopOwner(id);
      const running = this.historyTurn.get(id) ?? this.desktopTurn.get(id);
      if (owner && running) {
        await this.opts.desktop!.interruptTurn(owner, id, running === "pending" ? undefined : running);
        return;
      }
    }
    const turnId = id && this.activeTurn.get(id);
    if (!this.codex || !id || !turnId) throw new Error("Nothing is running that the watch can stop");
    await this.codex.request("turn/interrupt", { threadId: id, turnId });
  }

  decide(accept: boolean) {
    if (!this.codex || !this.approval) throw new Error("Nothing is waiting for approval");
    this.codex.respond(this.approval.rpcId, { decision: accept ? "accept" : "decline" });
    this.approval = null;
    this.publish();
  }

  async selectThread(id: string) {
    if (!this.threads.some((t) => t.id === id)) throw new Error("Unknown thread");
    this.selectedId = id;
    this.pinned = true;
    this.wantNew = false;
    this.activity = "";
    this.lastMessage = "";
    this.streaming = "";
    this.failed = false;
    await this.readLastMessage(id).catch(() => {});
    this.publish();
  }

  newThread() {
    this.selectedId = null;
    this.wantNew = true;
    this.activity = "";
    this.lastMessage = "";
    this.streaming = "";
    this.failed = false;
    this.publish();
  }
}
