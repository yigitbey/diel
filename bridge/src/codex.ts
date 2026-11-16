// Minimal JSON-RPC client for `codex app-server`.
// The app-server speaks JSON-RPC 2.0 without the "jsonrpc" header, either as
// newline-delimited JSON over stdio or one message per WebSocket text frame.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type Json = any;

export interface Transport {
  send(msg: Json): void;
  close(): void;
  onMessage: (msg: Json) => void;
  onClose: (why: string) => void;
}

/** Spawn an app-server child process and talk NDJSON over its stdio. */
export function stdioTransport(bin: string, args: string[] = ["app-server"]): Transport {
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
  const t: Transport = {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    close: () => child.kill(),
    onMessage: () => {},
    onClose: () => {},
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      t.onMessage(JSON.parse(line));
    } catch {
      // Non-JSON output on stdout is ignored.
    }
  });
  child.on("error", (e) => t.onClose(`spawn failed: ${e.message}`));
  child.on("exit", (code) => t.onClose(`app-server exited (${code})`));
  return t;
}

/**
 * Connect to an already running app-server.
 * `target` is a ws:// URL or an absolute unix socket path.
 */
export function wsTransport(target: string, bearer?: string): Promise<Transport> {
  const url = target.startsWith("/") ? `ws+unix:${target}:/` : target;
  const ws = new WebSocket(url, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
  });
  const t: Transport = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    onMessage: () => {},
    onClose: () => {},
  };
  ws.on("message", (data) => {
    try {
      t.onMessage(JSON.parse(data.toString()));
    } catch {
      // ignore malformed frames
    }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.on("close", () => t.onClose("app-server connection closed"));
      ws.on("error", (e) => t.onClose(`app-server connection error: ${e.message}`));
      resolve(t);
    });
    ws.once("error", reject);
  });
}

/**
 * Events:
 *  - "notification" (method, params)
 *  - "request" (id, method, params): server-initiated, answer with respond()/reject()
 *  - "close" (why)
 */
export class CodexClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private transport: Transport;
  closed = false;

  constructor(transport: Transport) {
    super();
    this.transport = transport;
    transport.onMessage = (m) => this.handle(m);
    transport.onClose = (why) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.emit("close", why);
    };
  }

  private handle(m: Json) {
    const hasId = m.id !== undefined && m.id !== null;
    if (hasId && m.method) {
      this.emit("request", m.id, m.method, m.params ?? {});
    } else if (hasId) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else p.resolve(m.result);
    } else if (m.method) {
      this.emit("notification", m.method, m.params ?? {});
    }
  }

  request(method: string, params: Json = {}, timeoutMs = 30_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("app-server not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.transport.send({ method, id, params });
    });
  }

  notify(method: string, params?: Json) {
    if (!this.closed) this.transport.send(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: Json) {
    if (!this.closed) this.transport.send({ id, result });
  }

  reject(id: number | string, message: string) {
    if (!this.closed) this.transport.send({ id, error: { code: -32601, message } });
  }

  async initialize() {
    const res = await this.request("initialize", {
      clientInfo: { name: "diel_bridge", title: "Diel watch bridge", version: "0.1.0" },
    });
    this.notify("initialized");
    return res;
  }

  close() {
    this.transport.close();
  }
}
