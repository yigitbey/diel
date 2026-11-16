import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { CodexClient } from "../src/codex.ts";
import { Agent } from "../src/state.ts";
import { startServer } from "../src/server.ts";
import { FakeAppServer } from "./fake-app-server.ts";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const fake = new FakeAppServer();
  const agent = new Agent({ cwd: "/tmp", pollMs: 1_000_000 });
  await agent.attach(new CodexClient(fake.transport));
  return { fake, agent, done: () => agent.stopPolling() };
}

test("starts idle on the most recent thread with its last message", async () => {
  const { agent, done } = await setup();
  const s = agent.snapshot();
  assert.equal(s.status, "idle");
  assert.deepEqual(s.thread, { id: "t1", title: "Fix the login bug" });
  assert.equal(s.lastMessage, "Login is fixed.");
  assert.equal(s.threads.length, 2);
  done();
});

test("say starts a turn, then steers while it is running", async () => {
  const { fake, agent, done } = await setup();
  assert.equal(await agent.say("run the tests"), "started");
  assert.equal(fake.count("thread/resume"), 1);
  assert.deepEqual(fake.last("turn/start"), { threadId: "t1", input: [{ type: "text", text: "run the tests" }] });
  assert.equal(agent.snapshot().status, "working");

  assert.equal(await agent.say("only the unit ones"), "steered");
  assert.equal(fake.last("turn/steer").expectedTurnId, "turn1");
  assert.equal(fake.count("turn/start"), 1);
  assert.equal(fake.count("thread/resume"), 1, "thread is resumed only once");
  done();
});

test("events drive activity, streaming text and completion", async () => {
  const { fake, agent, done } = await setup();
  await agent.say("go");
  fake.emit("turn/started", { threadId: "t1", turn: { id: "turn1" } });
  fake.emit("item/started", { threadId: "t1", item: { type: "commandExecution", command: "npm test" } });
  assert.equal(agent.snapshot().activity, "Running npm test");

  fake.emit("item/started", { threadId: "t1", item: { type: "agentMessage", id: "m1" } });
  fake.emit("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "All " });
  fake.emit("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "green." });
  assert.equal(agent.snapshot().lastMessage, "All green.");

  fake.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "completed" } });
  const s = agent.snapshot();
  assert.equal(s.status, "idle");
  assert.equal(s.activity, "");
  assert.equal(s.lastMessage, "All green.");

  // After completion the next instruction starts a new turn instead of steering.
  assert.equal(await agent.say("again"), "started");
  done();
});

test("events for other threads don't leak into the shown one", async () => {
  const { fake, agent, done } = await setup();
  fake.emit("item/agentMessage/delta", { threadId: "t0", itemId: "x", delta: "noise" });
  assert.equal(agent.snapshot().lastMessage, "Login is fixed.");
  done();
});

test("failed turn shows error with its message", async () => {
  const { fake, agent, done } = await setup();
  await agent.say("go");
  fake.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "failed", error: { message: "rate limited" } } });
  const s = agent.snapshot();
  assert.equal(s.status, "error");
  assert.equal(s.lastMessage, "rate limited");
  done();
});

test("approval round trip", async () => {
  const { fake, agent, done } = await setup();
  await agent.say("delete the build dir");
  const id = fake.ask("item/commandExecution/requestApproval", { threadId: "t1", turnId: "turn1", command: "rm -rf build" });
  let s = agent.snapshot();
  assert.equal(s.status, "needs-you");
  assert.equal(s.approval?.summary, "Run: rm -rf build");

  agent.decide(true);
  await tick();
  assert.deepEqual(fake.responses.at(-1), { id, result: { decision: "accept" } });
  assert.equal(agent.snapshot().status, "working");

  const id2 = fake.ask("item/fileChange/requestApproval", { threadId: "t1", turnId: "turn1" });
  agent.decide(false);
  await tick();
  assert.deepEqual(fake.responses.at(-1), { id: id2, result: { decision: "decline" } });
  assert.throws(() => agent.decide(true), /Nothing is waiting/);
  done();
});

test("unsupported server requests are refused instead of left hanging", async () => {
  const { fake, done } = await setup();
  const id = fake.ask("mcpServer/elicitation/request", {});
  await tick();
  assert.equal(fake.responses.at(-1)?.id, id);
  assert.ok(fake.responses.at(-1)?.error);
  done();
});

test("new thread, stop, and going offline", async () => {
  const { fake, agent, done } = await setup();
  await assert.rejects(agent.stop(), /Nothing is running/);
  agent.newThread();
  assert.equal(agent.snapshot().thread, null);
  await agent.say("hello");
  assert.equal(fake.last("thread/start").cwd, "/tmp");
  assert.equal(agent.snapshot().thread?.id, fake.threads[0].id);
  await agent.stop();
  assert.deepEqual(fake.last("turn/interrupt"), { threadId: fake.threads[0].id, turnId: "turn1" });

  fake.transport.close();
  assert.equal(agent.snapshot().status, "offline");
  await assert.rejects(agent.say("anyone there"), /offline/);
  done();
});

test("watch socket: rejects bad token, serves state and commands with a good one", async () => {
  const { fake, agent, done } = await setup();
  const server = await startServer(agent, { port: 0, host: "127.0.0.1", token: "secret-token" });
  const port = (server.http.address() as { port: number }).port;
  const open = (token: string) =>
    new Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/watch`);
      const frames: any[] = [];
      ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "hello", token }));
        resolve({ ws, frames, closed });
      });
    });

  const bad = await open("wrong-token!");
  assert.equal(await bad.closed, 4401);
  assert.equal(bad.frames.length, 0, "no state leaks before auth");

  const good = await open("secret-token");
  await tick(50);
  assert.equal(good.frames[0].type, "state");
  assert.equal(good.frames[0].lastMessage, "Login is fixed.");

  good.ws.send(JSON.stringify({ type: "say", text: "ship it" }));
  await tick(50);
  assert.equal(fake.last("turn/start").input[0].text, "ship it");
  assert.ok(good.frames.some((f) => f.type === "ack" && f.for === "say" && f.ok));
  assert.equal(good.frames.findLast((f) => f.type === "state").status, "working");

  good.ws.send(JSON.stringify({ type: "approve" }));
  await tick(50);
  assert.ok(good.frames.some((f) => f.type === "ack" && f.for === "approve" && !f.ok));

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("secret-token"), "loopback gets the mock page");

  await server.close();
  done();
});

test("pairing window hands the token to one watch, presence needs the token", async () => {
  const { agent, done } = await setup();
  const changes: boolean[] = [];
  const server = await startServer(agent, {
    port: 0,
    host: "127.0.0.1",
    token: "secret-token",
    identity: { id: "mac1", name: "Test Mac", idleSeconds: () => 42 },
    onPairingChange: (open) => changes.push(open),
  });
  const port = (server.http.address() as { port: number }).port;
  const ask = (msg: object) =>
    new Promise<{ frames: any[]; code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/watch`);
      const frames: any[] = [];
      ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
      ws.on("open", () => ws.send(JSON.stringify(msg)));
      ws.on("close", (code) => resolve({ frames, code }));
    });

  // Closed by default.
  assert.equal((await ask({ type: "pair", device: "watch" })).code, 4403);

  // Only this Mac can open it.
  const open = await fetch(`http://127.0.0.1:${port}/pair-mode`, { method: "POST" });
  assert.equal(open.status, 200);
  const paired = await ask({ type: "pair", device: "watch" });
  assert.deepEqual(paired.frames[0], { type: "paired", id: "mac1", name: "Test Mac", token: "secret-token" });
  // One watch per window.
  assert.equal((await ask({ type: "pair", device: "other" })).code, 4403);
  assert.deepEqual(changes, [true, false]);

  assert.equal((await fetch(`http://127.0.0.1:${port}/presence`)).status, 401);
  const presence = await fetch(`http://127.0.0.1:${port}/presence`, { headers: { authorization: "Bearer secret-token" } });
  assert.deepEqual(await presence.json(), { id: "mac1", name: "Test Mac", idleSeconds: 42, status: "idle" });

  await server.close();
  done();
});
