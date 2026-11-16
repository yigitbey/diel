// LAN-facing WebSocket server for the watch, plus a localhost-only mock watch page.
//
// Watch protocol (JSON text frames):
//   watch -> bridge: {type:"hello", token}            must be the first frame
//                    {type:"say", text}
//                    {type:"stop"} | {type:"approve"} | {type:"deny"}
//                    {type:"selectThread", id} | {type:"newThread"}
//                    {type:"voiceStart"} | {type:"voiceStop"}   live voice session
//                    binary frames                               mic audio, PCM16 24 kHz mono
//   bridge -> watch: {type:"state", ...Snapshot, voice} on connect and on every change
//                    {type:"ack", for, ok, detail}      result of a command
//                    {type:"voice", state, detail}      connecting | listening | speaking | off
//                    {type:"voiceClear"}                 drop queued playback (user interrupted)
//                    {type:"caption", role, text}        what was said
//                    binary frames                       speech to play, PCM16 24 kHz mono

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Agent, Snapshot } from "./state.ts";
import { VoiceSession } from "./voice.ts";
import type { VoiceConfig } from "./voice.ts";

const AUTH_TIMEOUT_MS = 5000;
const MAX_TEXT = 4000;

function isLoopback(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function tokenMatches(given: unknown, expected: string) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface BridgeServer {
  http: Server;
  close(): Promise<void>;
}

export function startServer(agent: Agent, opts: { port: number; host?: string; token: string; voice?: VoiceConfig | null }): Promise<BridgeServer> {
  const debugPage = readFileSync(new URL("./debug.html", import.meta.url), "utf8");

  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // The mock watch page embeds the token, so it is only ever served to this Mac.
    if (req.url === "/" && isLoopback(req)) {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(debugPage.replace("__DIEL_TOKEN__", opts.token));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/watch", maxPayload: 64 * 1024 });
  const authed = new Set<WebSocket>();
  const frame = (snap: Snapshot) => JSON.stringify({ ...snap, voice: !!opts.voice });

  agent.on("change", (snap) => {
    const f = frame(snap);
    for (const ws of authed) ws.send(f);
  });

  wss.on("connection", (ws) => {
    const timer = setTimeout(() => ws.close(4401, "auth timeout"), AUTH_TIMEOUT_MS);
    let voice: VoiceSession | null = null;
    ws.on("close", () => {
      clearTimeout(timer);
      authed.delete(ws);
      voice?.stop();
      voice = null;
    });
    ws.on("error", () => {});

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (authed.has(ws)) voice?.appendAudio(data as Buffer);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(4400, "bad json");
      }

      if (!authed.has(ws)) {
        if (msg?.type !== "hello" || !tokenMatches(msg.token, opts.token)) return ws.close(4401, "bad token");
        clearTimeout(timer);
        authed.add(ws);
        ws.send(frame(agent.snapshot()));
        return;
      }

      const ack = (ok: boolean, detail = "") => ws.send(JSON.stringify({ type: "ack", for: msg.type, ok, detail }));
      try {
        switch (msg.type) {
          case "say": {
            if (typeof msg.text !== "string" || msg.text.length > MAX_TEXT) throw new Error("Bad text");
            ack(true, await agent.say(msg.text));
            break;
          }
          case "stop":
            await agent.stop();
            ack(true);
            break;
          case "approve":
          case "deny":
            agent.decide(msg.type === "approve");
            ack(true);
            break;
          case "selectThread":
            await agent.selectThread(String(msg.id));
            ack(true);
            break;
          case "newThread":
            agent.newThread();
            ack(true);
            break;
          case "voiceStart": {
            if (!opts.voice) throw new Error("No OpenAI API key on the Mac");
            voice?.stop();
            const session = new VoiceSession(agent, opts.voice, {
              audio: (pcm) => ws.readyState === ws.OPEN && ws.send(pcm, { binary: true }),
              event: (e) => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
                if (e.type === "voice" && e.state === "off" && voice === session) voice = null;
              },
            });
            voice = session;
            session.start();
            break;
          }
          case "voiceStop":
            voice?.stop();
            voice = null;
            break;
          case "ping":
            ws.send('{"type":"pong"}');
            break;
          default:
            ack(false, "Unknown command");
        }
      } catch (e) {
        ack(false, e instanceof Error ? e.message : String(e));
      }
    });
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host ?? "0.0.0.0", () =>
      resolve({
        http,
        close: () =>
          new Promise((done) => {
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      }),
    );
  });
}
