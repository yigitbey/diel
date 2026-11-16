import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../src/codex.ts";
import { Agent } from "../src/state.ts";
import { DesktopIpc } from "../src/desktop.ts";
import { FakeAppServer } from "./fake-app-server.ts";

/** Stand-in for the desktop app's IPC router, owning thread t1. */
async function fakeRouter() {
  const path = join(mkdtempSync(join(tmpdir(), "diel-")), "ipc.sock");
  const requests: any[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (m: object) => {
      const b = Buffer.from(JSON.stringify(m));
      const h = Buffer.alloc(4);
      h.writeUInt32LE(b.length);
      sock.write(Buffer.concat([h, b]));
    };
    // Routers probe clients; the bridge must answer instead of hanging the router.
    send({ type: "client-discovery-request", requestId: "probe", request: { method: "ide-context" } });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const n = buf.readUInt32LE(0);
        const m = JSON.parse(buf.subarray(4, 4 + n).toString());
        buf = buf.subarray(4 + n);
        requests.push(m);
        if (m.type !== "request") continue;
        const ok = (extra: object) => send({ type: "response", requestId: m.requestId, resultType: "success", method: m.method, handledByClientId: "owner", ...extra });
        if (m.method === "initialize") ok({ result: { clientId: "bridge" } });
        else if (m.method === "thread-owner-discovery")
          m.params.conversationId === "t1" ? ok({ result: { supportsUntrustedAppInput: true } }) : send({ type: "response", requestId: m.requestId, resultType: "error", error: "no-client-found" });
        else if (m.method === "thread-follower-start-turn") ok({ result: { result: { turn: { id: "dt1", status: "inProgress" } } } });
        else ok({ result: { ok: true } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, requests, of: (method: string) => requests.filter((r) => r.method === method), close: () => new Promise((r) => server.close(r)) };
}

test("threads open in the desktop app are driven through its IPC", async () => {
  const router = await fakeRouter();
  const fake = new FakeAppServer();
  const desktop = new DesktopIpc(router.path);
  const agent = new Agent({ cwd: "/tmp", pollMs: 1_000_000, desktop });
  await agent.attach(new CodexClient(fake.transport));

  assert.equal(await agent.say("run the tests"), "started");
  const start = router.of("thread-follower-start-turn")[0];
  assert.equal(start.version, 2);
  assert.equal(start.targetClientId, "owner");
  assert.equal(start.params.turnStart.request.input[0].text, "run the tests");
  assert.equal(fake.count("thread/resume"), 0, "never tries to take over the desktop's thread");
  assert.equal(fake.count("turn/start"), 0);
  assert.equal(agent.snapshot().status, "working");
  assert.ok(router.requests.some((r) => r.type === "client-discovery-response" && r.response.canHandle === false));

  // Progress comes from stored history while the turn runs...
  // Codex stores a turn that is still running as "interrupted" with no completedAt.
  fake.history.t1.push({ id: "dt1", status: "interrupted", completedAt: null, items: [{ type: "userMessage" }] });
  fake.threads[0].updatedAt = Date.now() / 1000;
  await (agent as any).refreshThreads();
  assert.equal(agent.snapshot().status, "working", "an unfinished turn is not mistaken for done");
  assert.equal(agent.snapshot().lastMessage, "", "the previous reply is not shown as this turn's answer");
  fake.history.t1[1] = { id: "dt1", status: "interrupted", completedAt: null, items: [{ type: "commandExecution", command: "npm test" }] };
  await (agent as any).refreshThreads();
  assert.equal(agent.snapshot().activity, "Running npm test");

  // ...a second instruction steers it...
  assert.equal(await agent.say("only unit tests"), "steered");
  assert.equal(router.of("thread-follower-steer-turn")[0].params.input[0].text, "only unit tests");

  // ...and the watch sees it finish.
  fake.history.t1[1] = { id: "dt1", status: "completed", completedAt: 1, items: [{ type: "agentMessage", text: "All green." }] };
  await (agent as any).refreshThreads();
  assert.equal(agent.snapshot().status, "idle");
  assert.equal(agent.snapshot().lastMessage, "All green.");

  agent.stopPolling();
  desktop.close();
  await router.close();
});

test("threads the desktop app doesn't own still use the bridge's own app-server", async () => {
  const router = await fakeRouter();
  const fake = new FakeAppServer();
  const desktop = new DesktopIpc(router.path);
  const agent = new Agent({ cwd: "/tmp", pollMs: 1_000_000, desktop });
  await agent.attach(new CodexClient(fake.transport));
  await agent.selectThread("t0");
  assert.equal(await agent.say("hello"), "started");
  assert.equal(fake.last("turn/start").threadId, "t0");
  assert.equal(router.of("thread-follower-start-turn").length, 0);
  agent.stopPolling();
  desktop.close();
  await router.close();
});

test("no desktop app running falls back cleanly", async () => {
  const fake = new FakeAppServer();
  const desktop = new DesktopIpc("/nonexistent/ipc.sock");
  const agent = new Agent({ cwd: "/tmp", pollMs: 1_000_000, desktop });
  await agent.attach(new CodexClient(fake.transport));
  assert.equal(await agent.say("hi"), "started");
  assert.equal(fake.last("turn/start").threadId, "t1");
  agent.stopPolling();
});
