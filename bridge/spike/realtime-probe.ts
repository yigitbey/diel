// Checks whether Codex's own (experimental) voice mode works with the ChatGPT
// login on this Mac, i.e. without an OpenAI API key.   node spike/realtime-probe.ts
import { CodexClient, stdioTransport } from "../src/codex.ts";
import { findCodexBin } from "../src/config.ts";
import { readFileSync } from "node:fs";

const c = new CodexClient(stdioTransport(findCodexBin()!));
const seen: Record<string, number> = {};
let audioBytes = 0;
let format = "";
c.on("notification", (m: string, p: any) => {
  if (!m.startsWith("thread/realtime")) return;
  seen[m] = (seen[m] ?? 0) + 1;
  if (m === "thread/realtime/outputAudio/delta") {
    audioBytes += Buffer.from(p.audio.data, "base64").length;
    format = `${p.audio.sampleRate} Hz, ${p.audio.numChannels} ch`;
  } else if (seen[m] <= 2) console.log(" ", m, JSON.stringify(p).slice(0, 300));
});
c.on("request", (id: any, m: string) => c.reject(id, "probe"));
const step = async (label: string, f: () => Promise<any>) => {
  try {
    const r = await f();
    console.log(label, "ok", JSON.stringify(r ?? null).slice(0, 300));
    return r;
  } catch (e) {
    console.log(label, "FAILED:", e instanceof Error ? e.message : e);
    return null;
  }
};
await step("initialize", () => c.request("initialize", { clientInfo: { name: "diel_probe", title: "Diel probe", version: "0" }, capabilities: { experimentalApi: true } }));
c.notify("initialized");
await step("listVoices", () => c.request("thread/realtime/listVoices", {}));
const t = await step("thread/start", () => c.request("thread/start", { ephemeral: true }));
const threadId = t?.thread?.id;
if (threadId) {
  const started = await step("realtime/start", () => c.request("thread/realtime/start", { threadId, outputModality: "audio", transport: process.env.RTC ? { type: "webrtc", sdp: readFileSync(process.env.RTC, "utf8") } : { type: "websocket" }, ...(process.env.VER ? { version: process.env.VER } : {}) }));
  if (started !== null) {
    await new Promise((r) => setTimeout(r, 3000));
    await step("appendText", () => c.request("thread/realtime/appendText", { threadId, text: "Say the single word hello." }));
    await new Promise((r) => setTimeout(r, 1500));
    await step("realtime/stop", () => c.request("thread/realtime/stop", { threadId }));
  }
}
console.log("notifications:", seen);
console.log(`audio received: ${audioBytes} bytes ${format}`);
c.close();
process.exit(0);
