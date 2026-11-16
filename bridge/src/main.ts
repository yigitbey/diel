// Diel bridge entry point.
//
// Environment:
//   DIEL_PORT        port for the watch (default 8791)
//   DIEL_CODEX_URL   attach to a running app-server: ws://host:port or /abs/path.sock
//   DIEL_CODEX_TOKEN bearer token for DIEL_CODEX_URL, if that server requires one
//   DIEL_CODEX_BIN   codex binary to spawn when DIEL_CODEX_URL is not set
//   DIEL_OPENAI_KEY  OpenAI API key for live voice (or put it in ~/.diel/openai_key)
//   DIEL_VOICE       voice name for live voice (default marin)
//   DIEL_CWD         working directory for threads started from the watch

import { homedir } from "node:os";
import { CodexClient, stdioTransport, wsTransport } from "./codex.ts";
import { Agent } from "./state.ts";
import { DesktopIpc } from "./desktop.ts";
import { startServer } from "./server.ts";
import { PORT, findCodexBin, lanAddress, loadOpenAIKey, loadToken } from "./config.ts";

const agent = new Agent({ cwd: process.env.DIEL_CWD ?? homedir(), desktop: new DesktopIpc() });
const token = loadToken();

async function connectCodex(): Promise<CodexClient> {
  const url = process.env.DIEL_CODEX_URL;
  if (url) return new CodexClient(await wsTransport(url, process.env.DIEL_CODEX_TOKEN));
  const bin = findCodexBin();
  if (!bin) throw new Error("codex binary not found; install the Codex app or set DIEL_CODEX_BIN");
  return new CodexClient(stdioTransport(bin));
}

async function keepConnected() {
  let delay = 1000;
  let lastWhy = "";
  for (;;) {
    try {
      const codex = await connectCodex();
      const closed = new Promise<string>((r) => codex.once("close", r));
      await agent.attach(codex);
      console.log("connected to codex app-server");
      lastWhy = "";
      delay = 1000;
      console.log(`codex connection lost: ${await closed}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== lastWhy) console.log(`codex unavailable: ${why}`);
      lastWhy = why;
      agent.setNotice(why.includes("not found") ? "Codex isn't installed on the Mac" : "Codex isn't running on the Mac");
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15_000);
  }
}

const apiKey = loadOpenAIKey();
await startServer(agent, {
  port: PORT,
  token,
  voice: apiKey ? { apiKey, voice: process.env.DIEL_VOICE, model: process.env.DIEL_VOICE_MODEL } : null,
});
console.log(apiKey ? "live voice     enabled" : "live voice     off (no key in ~/.diel/openai_key); watch falls back to dictation");
console.log(`watch endpoint  ws://${lanAddress() ?? "<no LAN address>"}:${PORT}/watch`);
console.log(`mock watch page http://localhost:${PORT}/`);
keepConnected();
