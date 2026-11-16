// In-process stand-in for `codex app-server`, driven by the tests.

import type { Transport, Json } from "../src/codex.ts";

export class FakeAppServer {
  transport: Transport;
  calls: { method: string; params: Json }[] = [];
  responses: { id: number | string; result?: Json; error?: Json }[] = [];
  threads: Json[] = [
    { id: "t1", preview: "Fix the login bug", updatedAt: 1000, status: { type: "notLoaded" } },
    { id: "t0", preview: "Older work", updatedAt: 500, status: { type: "notLoaded" } },
  ];
  history: Record<string, Json[]> = {
    t1: [{ id: "old", status: "completed", items: [{ type: "agentMessage", text: "Login is fixed." }] }],
  };
  private turnSeq = 0;
  private reqSeq = 1000;

  constructor() {
    this.transport = {
      send: (m) => queueMicrotask(() => this.receive(m)),
      close: () => this.transport.onClose("closed"),
      onMessage: () => {},
      onClose: () => {},
    };
  }

  /** Server -> client notification. */
  emit(method: string, params: Json) {
    this.transport.onMessage({ method, params });
  }

  /** Server -> client request; returns its id. */
  ask(method: string, params: Json) {
    const id = this.reqSeq++;
    this.transport.onMessage({ id, method, params });
    return id;
  }

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }

  last(method: string) {
    return this.calls.findLast((c) => c.method === method)?.params;
  }

  private receive(m: Json) {
    if (m.method === undefined) {
      this.responses.push(m);
      return;
    }
    this.calls.push({ method: m.method, params: m.params });
    if (m.id === undefined) return;
    const reply = (result: Json) => this.transport.onMessage({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "fake" });
      case "thread/list":
        return reply({ data: this.threads, nextCursor: null });
      case "thread/read":
        return reply({ thread: { id: m.params.threadId, turns: this.history[m.params.threadId] ?? [] } });
      case "thread/resume":
        return reply({ thread: { id: m.params.threadId } });
      case "thread/start": {
        const thread = { id: `new${this.threads.length}`, preview: "", updatedAt: 2000, status: { type: "idle" } };
        this.threads.unshift(thread);
        return reply({ thread });
      }
      case "turn/start":
        return reply({ turn: { id: `turn${++this.turnSeq}`, status: "inProgress", items: [] } });
      case "turn/steer":
        return reply({ turnId: m.params.expectedTurnId });
      case "turn/interrupt":
        return reply({});
      default:
        return this.transport.onMessage({ id: m.id, error: { code: -32601, message: "unknown method" } });
    }
  }
}
