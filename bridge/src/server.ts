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

export interface Identity {
  /** Stable id of this Mac's bridge, so the watch can tell Macs apart when their addresses change. */
  id: string;
  /** Name shown on the watch, e.g. the Mac's computer name. */
  name: string;
  /** Seconds since the last keyboard or mouse input on this Mac. */
  idleSeconds: () => number;
}

export interface ServerOptions {
  port: number;
  host?: string;
  token: string;
  voice?: VoiceConfig | null;
  identity?: Identity;
  /** Called when a pairing window opens or closes, e.g. to update the network announcement. */
  onPairingChange?: (open: boolean) => void;
}

const PAIRING_WINDOW_MS = 120_000;

export function startServer(agent: Agent, opts: ServerOptions): Promise<BridgeServer> {
  const identity: Identity = opts.identity ?? { id: "local", name: "Mac", idleSeconds: () => 0 };
  let pairingUntil = 0;
  let pairingTimer: NodeJS.Timeout | null = null;
  const pairingOpen = () => Date.now() < pairingUntil;
  const setPairing = (open: boolean) => {
    if (pairingTimer) clearTimeout(pairingTimer);
    pairingTimer = null;
    pairingUntil = open ? Date.now() + PAIRING_WINDOW_MS : 0;
    if (open) pairingTimer = setTimeout(() => setPairing(false), PAIRING_WINDOW_MS);
    opts.onPairingChange?.(open);
  };
  const debugPage = readFileSync(new URL("./debug.html", import.meta.url), "utf8");

  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // Lets a paired watch compare Macs and follow the one you're using.
    if (req.url === "/presence" && req.method === "GET") {
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokenMatches(auth, opts.token)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
        JSON.stringify({ id: identity.id, name: identity.name, idleSeconds: identity.idleSeconds(), status: agent.snapshot().status }),
      );
      return;
    }
    // `npm run pair` on this Mac opens a short window in which one watch may pair.
    if (req.url === "/pair-mode" && req.method === "POST" && isLoopback(req)) {
      setPairing(true);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seconds: PAIRING_WINDOW_MS / 1000, name: identity.name }));
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
  const frame = (snap: Snapshot) => JSON.stringify({ ...snap, voice: !!opts.voice, mac: { id: identity.id, name: identity.name } });

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
        // Pairing: while the window is open, the first watch that asks gets this Mac's token.
        if (msg?.type === "pair") {
          if (!pairingOpen()) return ws.close(4403, "pairing is closed");
          setPairing(false);
          ws.send(JSON.stringify({ type: "paired", id: identity.id, name: identity.name, token: opts.token }));
          console.log(`paired with ${String(msg.device ?? "a watch").slice(0, 60)}`);
          return ws.close(1000, "paired");
        }
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
            if (pairingTimer) clearTimeout(pairingTimer);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      }),
    );
  });
}
