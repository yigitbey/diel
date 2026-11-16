import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { WebSocket as ServerSocket } from "ws";
import { CodexClient } from "../src/codex.ts";
import { Agent } from "../src/state.ts";
import { VoiceSession } from "../src/voice.ts";
import { FakeAppServer } from "./fake-app-server.ts";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for the OpenAI Realtime endpoint. */
async function fakeRealtime() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const received: any[] = [];
  let socket: ServerSocket | null = null;
  let auth = "";
  wss.on("connection", (ws, req) => {
    socket = ws;
    auth = String(req.headers.authorization);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      received.push(m);
      if (m.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      if (m.type === "response.create") ws.send(JSON.stringify({ type: "response.created" }));
    });
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    received,
    auth: () => auth,
    emit: (e: object) => socket!.send(JSON.stringify(e)),
    of: (type: string) => received.filter((m) => m.type === type),
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}

async function setup() {
  const fake = new FakeAppServer();
  const agent = new Agent({ cwd: "/tmp", pollMs: 1_000_000 });
  await agent.attach(new CodexClient(fake.transport));
  const rt = await fakeRealtime();
  const audio: Buffer[] = [];
  const events: any[] = [];
  const voice = new VoiceSession(agent, { apiKey: "sk-test", url: rt.url }, { audio: (b) => audio.push(b), event: (e) => events.push(e) });
  voice.start();
  await tick(80);
  return { fake, agent, rt, audio, events, voice, done: async () => { voice.stop(); agent.stopPolling(); await rt.close(); } };
}

test("configures the session, authenticates, and greets", async () => {
  const { rt, events, done } = await setup();
  assert.equal(rt.auth(), "Bearer sk-test");
  const s = rt.of("session.update")[0].session;
  assert.equal(s.type, "realtime");
  assert.deepEqual(s.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(s.audio.input.turn_detection.type, "semantic_vad");
  assert.ok(s.tools.some((t: any) => t.name === "send_to_agent"));
  assert.deepEqual(events.map((e) => e.state).filter(Boolean).slice(0, 2), ["connecting", "listening"]);
  assert.equal(rt.of("response.create").length, 1, "greeting requested once");
  await done();
});

test("relays audio both ways and clears playback on interruption", async () => {
  const { rt, audio, events, voice, done } = await setup();
  voice.appendAudio(Buffer.from([1, 2, 3, 4]));
  rt.emit({ type: "response.output_audio.delta", delta: Buffer.from([9, 8, 7, 6]).toString("base64") });
  rt.emit({ type: "input_audio_buffer.speech_started" });
  await tick();
  assert.equal(rt.of("input_audio_buffer.append")[0].audio, Buffer.from([1, 2, 3, 4]).toString("base64"));
  assert.deepEqual([...audio[0]], [9, 8, 7, 6]);
  assert.ok(events.some((e) => e.type === "voiceClear"));
  await done();
});

test("a spoken instruction reaches the agent through the tool call", async () => {
  const { fake, rt, done } = await setup();
  rt.emit({ type: "response.done", response: { output: [] } }); // greeting finished
  await tick();
  rt.emit({ type: "response.created" });
  rt.emit({
    type: "response.done",
    response: { output: [{ type: "function_call", name: "send_to_agent", call_id: "c1", arguments: JSON.stringify({ instruction: "run the tests" }) }] },
  });
  await tick();
  assert.equal(fake.last("turn/start").input[0].text, "run the tests");
  const out = rt.of("conversation.item.create").find((m) => m.item.type === "function_call_output");
  assert.equal(out.item.call_id, "c1");
  const result = JSON.parse(out.item.output);
  assert.equal(result.result, "started");
  assert.match(result.note, /not known yet/);
  assert.equal(rt.of("response.create").length, 2, "asks the model to speak after the tool result");
  await done();
});

test("agent finishing is announced, but only after the model stops talking", async () => {
  const { fake, agent, rt, done } = await setup();
  await agent.say("go"); // working, while the greeting response is still active
  fake.emit("item/completed", { threadId: "t1", item: { type: "agentMessage", text: "All tests pass." } });
  fake.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "completed" } });
  await tick();
  const notes = () => rt.of("conversation.item.create").filter((m) => m.item.role === "system" && m.item.content[0].text.includes("finished"));
  assert.equal(notes().length, 0, "held back while a response is in progress");
  rt.emit({ type: "response.done", response: { output: [] } });
  await tick();
  assert.equal(notes().length, 1);
  assert.ok(notes()[0].item.content[0].text.includes("All tests pass."));
  await done();
});

test("permission is only answered through the tool", async () => {
  const { fake, agent, rt, events, done } = await setup();
  rt.emit({ type: "response.done", response: { output: [] } });
  await agent.say("clean up");
  const id = fake.ask("item/commandExecution/requestApproval", { threadId: "t1", turnId: "turn1", command: "rm -rf build" });
  await tick();
  assert.ok(rt.of("conversation.item.create").some((m) => m.item.role === "system" && m.item.content[0].text.includes("rm -rf build")));
  assert.equal(fake.responses.length, 0, "nothing approved yet");
  rt.emit({ type: "response.done", response: { output: [{ type: "function_call", name: "answer_permission", call_id: "c2", arguments: '{"approve":true}' }] } });
  await tick();
  assert.deepEqual(fake.responses.at(-1), { id, result: { decision: "accept" } });
  await done();
  assert.equal(events.at(-1).state, "off");
});
