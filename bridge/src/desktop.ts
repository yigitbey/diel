// Client for the Codex desktop app's local IPC router.
//
// The desktop app keeps the threads open in its window locked to its own
// app-server, so the bridge's app-server cannot write to them. Its windows
// forward turns to whichever window owns a thread through a router on a unix
// socket; the bridge joins that router as one more client and does the same.
//
// This is an undocumented, internal interface of the desktop app (found by
// reading its bundled code), so it can change with any app update. Every
// method fails soft: callers fall back to the bridge's own app-server.
//
// Framing: 4-byte little-endian length, then a UTF-8 JSON message.

import net from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Msg = any;

// Request versions the desktop app expects (from its bundled method table).
const VERSIONS: Record<string, number> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
};

export class DesktopIpc {
  private socketPath: string;
  private sock: net.Socket | null = null;
  private clientId: string | null = null;
  private connecting: Promise<void> | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (m: Msg) => void; timer: NodeJS.Timeout }>();

  constructor(socketPath = join(homedir(), ".codex", "ipc", "ipc.sock")) {
    this.socketPath = socketPath;
  }

  /** Thread id -> owning desktop client id, or null when no window owns it. */
  async findOwner(threadId: string): Promise<string | null> {
    try {
      const r = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, undefined, 3000);
      return r.resultType === "success" ? r.handledByClientId : null;
    } catch {
      return null;
    }
  }

  async startTurn(owner: string, threadId: string, text: string): Promise<string | null> {
    const r = await this.request(
      "thread-follower-start-turn",
      {
        conversationId: threadId,
        turnStart: { request: { threadId, clientUserMessageId: randomUUID(), input: [textInput(text)] }, context: {} },
      },
      owner,
    );
    return r.result?.result?.turn?.id ?? null;
  }

  async steerTurn(owner: string, threadId: string, text: string) {
    await this.request(
      "thread-follower-steer-turn",
      { conversationId: threadId, clientUserMessageId: randomUUID(), input: [textInput(text)] },
      owner,
    );
  }

  async interruptTurn(owner: string, threadId: string, turnId?: string) {
    await this.request("thread-follower-interrupt-turn", { conversationId: threadId, mode: "user-stop", expectedTurnId: turnId }, owner);
  }

  close() {
    this.sock?.destroy();
  }

  // ---- plumbing ----------------------------------------------------------

  private async request(method: string, params: Msg, targetClientId?: string, timeoutMs = 20_000): Promise<Msg> {
    await this.connect();
    const requestId = randomUUID();
    const reply = new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });
    this.write({
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version: VERSIONS[method] ?? 0,
      method,
      params,
      targetClientId,
      timeoutMs,
    });
    const r = await reply;
    if (r.resultType === "error" && method !== "thread-owner-discovery") throw new Error(`Codex app: ${r.error}`);
    return r;
  }

  private connect(): Promise<void> {
    if (this.sock && this.clientId) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!existsSync(this.socketPath)) return Promise.reject(new Error("Codex app is not running"));
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.connect(this.socketPath);
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Codex app IPC did not answer"));
      }, 3000);
      this.pending.set(requestId, {
        timer,
        resolve: (m) => {
          this.clientId = m.result?.clientId ?? null;
          this.clientId ? resolve() : reject(new Error("Codex app IPC refused the bridge"));
        },
      });
      sock.on("connect", () => this.write({ type: "request", requestId, method: "initialize", params: { clientType: "diel-bridge" } }));
      sock.on("data", (d) => this.onData(d));
      const drop = (e?: Error) => {
        if (this.sock !== sock) return;
        this.sock = null;
        this.clientId = null;
        for (const p of this.pending.values()) clearTimeout(p.timer);
        this.pending.clear();
        reject(e ?? new Error("Codex app IPC closed"));
      };
      sock.on("error", drop);
      sock.on("close", () => drop());
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private write(m: Msg) {
    const body = Buffer.from(JSON.stringify(m));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.sock?.write(Buffer.concat([head, body]));
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) return;
      let m: Msg;
      try {
        m = JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8"));
      } catch {
        m = null;
      }
      this.buf = this.buf.subarray(4 + n);
      if (!m) continue;
      if (m.type === "client-discovery-request") {
        // The router asks every client whether it can serve a request; the bridge never does.
        this.write({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } });
      } else if (m.type === "response") {
        const p = this.pending.get(m.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.requestId);
          p.resolve(m);
        }
      }
    }
  }
}

function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}
