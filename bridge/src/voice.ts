// Live voice: relays watch audio to an OpenAI Realtime session and back, and
// gives that voice model tools to drive the Codex agent.
//
// Audio both ways is raw PCM16, 24 kHz, mono.

import WebSocket from "ws";
import type { Agent, Snapshot } from "./state.ts";

export interface VoiceConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  /** Override for tests. */
  url?: string;
}

export type VoiceState = "connecting" | "listening" | "speaking" | "off";

export interface VoiceSink {
  audio(pcm: Buffer): void;
  event(e: { type: "voice"; state: VoiceState; detail?: string } | { type: "voiceClear" } | { type: "caption"; role: "you" | "diel"; text: string }): void;
}

const INSTRUCTIONS = `You are Diel, a voice companion living on the user's smartwatch. The user has a coding agent (Codex) running on their Mac, and you are how they talk to it while away from the keyboard.

How to behave:
- Speak briefly: one or two short sentences. The user is listening on a tiny watch speaker.
- You do not write code or do the work yourself. When the user wants something done, call send_to_agent with a clear, complete, self-contained instruction in their words. Then say in a few words that you passed it on.
- If a request is ambiguous, ask one short question before sending it.
- To answer "what's it doing?" or "is it done?", call get_status and summarise in plain speech. While the agent is working it has not answered yet: never present an earlier reply as its answer, just say it's still working. Never read code, file paths or long output aloud; summarise.
- Messages starting with [agent update] come from the system, not the user. Tell the user what happened in one or two sentences.
- When the agent asks permission, say what it wants to do and ask the user. Only call answer_permission after the user clearly says yes or no. Never approve on your own.
- Small talk is fine, but keep it short.`;

const TOOLS = [
  {
    type: "function",
    name: "send_to_agent",
    description: "Send an instruction to the coding agent on the Mac. If it is already working, the instruction steers the current work; otherwise it starts new work in the current thread.",
    parameters: {
      type: "object",
      properties: { instruction: { type: "string", description: "The full instruction, self-contained." } },
      required: ["instruction"],
    },
  },
  {
    type: "function",
    name: "get_status",
    description: "Get what the coding agent is doing right now, its current thread, its latest message, and any pending permission request.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "answer_permission",
    description: "Answer the agent's pending permission request. Only after the user explicitly said yes or no.",
    parameters: { type: "object", properties: { approve: { type: "boolean" } }, required: ["approve"] },
  },
  {
    type: "function",
    name: "stop_agent",
    description: "Interrupt what the coding agent is currently doing.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "new_thread",
    description: "Make the next instruction start a fresh conversation with the agent instead of continuing the current one.",
    parameters: { type: "object", properties: {} },
  },
];

function statusForModel(s: Snapshot) {
  return {
    status: s.status,
    thread: s.thread?.title ?? null,
    doing: s.activity || null,
    // While it works, the message so far is partial; once it is idle it is the final reply.
    ...(s.status === "working"
      ? { reply_so_far: s.lastMessage || null, note: "Still working. Its answer is not ready; wait for the [agent update] that it finished." }
      : { latest_message: s.lastMessage || null }),
    permission_request: s.approval?.summary ?? null,
  };
}

export class VoiceSession {
  private ws: WebSocket | null = null;
  private agent: Agent;
  private cfg: VoiceConfig;
  private sink: VoiceSink;
  private ready = false;
  private responding = false;
  private queued: string[] = []; // agent updates waiting for the model to finish talking
  private last: Snapshot;
  private onChange = (s: Snapshot) => this.agentChanged(s);
  private closed = false;

  constructor(agent: Agent, cfg: VoiceConfig, sink: VoiceSink) {
    this.agent = agent;
    this.cfg = cfg;
    this.sink = sink;
    this.last = agent.snapshot();
  }

  start() {
    const model = this.cfg.model ?? "gpt-realtime-2.1";
    const url = this.cfg.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    this.setState("connecting");
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          model,
          output_modalities: ["audio"],
          instructions: INSTRUCTIONS,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: { type: "semantic_vad" },
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: this.cfg.voice ?? "marin",
            },
          },
          tools: TOOLS,
          tool_choice: "auto",
        },
      });
    });
    ws.on("message", (data) => {
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(m);
    });
    ws.on("unexpected-response", (_req, res) => {
      const detail = res.statusCode === 401 ? "OpenAI rejected the API key" : `OpenAI refused the connection (${res.statusCode})`;
      this.finish(detail);
    });
    ws.on("error", (e) => this.finish(`Voice connection failed: ${e.message}`));
    ws.on("close", () => this.finish());
    this.agent.on("change", this.onChange);
  }

  /** PCM16 24 kHz mono from the watch microphone. */
  appendAudio(pcm: Buffer) {
    if (!this.ready) return;
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  stop() {
    this.finish();
  }

  private finish(detail?: string) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.agent.off("change", this.onChange);
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
    this.sink.event({ type: "voice", state: "off", detail });
  }

  private state: VoiceState = "off";
  private setState(state: VoiceState) {
    if (state === this.state) return;
    this.state = state;
    this.sink.event({ type: "voice", state });
  }

  private send(event: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private handle(m: any) {
    switch (m.type) {
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          this.setState("listening");
          // Greet with the current situation so the user knows it's live.
          this.say(`[agent update] The voice session just started. Current agent state: ${JSON.stringify(statusForModel(this.agent.snapshot()))}. Greet the user in a few words and mention the state only if the agent is busy, waiting for permission, or failed.`);
        }
        break;
      case "response.created":
        this.responding = true;
        break;
      case "response.output_audio.delta":
        if (m.delta) {
          this.setState("speaking");
          this.sink.audio(Buffer.from(m.delta, "base64"));
        }
        break;
      case "response.output_audio_transcript.done":
        if (m.transcript) this.sink.event({ type: "caption", role: "diel", text: m.transcript });
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript) this.sink.event({ type: "caption", role: "you", text: m.transcript });
        break;
      case "input_audio_buffer.speech_started":
        // The user started talking: drop whatever the watch still has queued to play.
        this.sink.event({ type: "voiceClear" });
        this.setState("listening");
        break;
      case "response.done":
        this.responding = false;
        this.setState("listening");
        this.afterResponse(m.response).catch(() => {});
        break;
      case "error":
        // Most errors are recoverable (e.g. cancelling nothing); surface only fatal-looking ones.
        if (!this.ready) this.finish(m.error?.message ?? "Voice session error");
        break;
    }
  }

  private async afterResponse(response: any) {
    const calls = (response?.output ?? []).filter((o: any) => o.type === "function_call");
    for (const call of calls) {
      const output = await this.runTool(call.name, call.arguments);
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) },
      });
    }
    if (calls.length) {
      this.send({ type: "response.create" });
      this.responding = true;
    } else {
      this.flush();
    }
  }

  private async runTool(name: string, rawArgs: string): Promise<object> {
    let args: any = {};
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return { ok: false, error: "Arguments were not valid JSON" };
    }
    try {
      switch (name) {
        case "send_to_agent":
          return {
            ok: true,
            result: await this.agent.say(String(args.instruction ?? "")),
            note: "Delivered. The agent is now working; its answer is not known yet. Do not guess or repeat an earlier reply. You will get an [agent update] when it finishes.",
          };
        case "get_status":
          return statusForModel(this.agent.snapshot());
        case "answer_permission":
          this.agent.decide(args.approve === true);
          return { ok: true };
        case "stop_agent":
          await this.agent.stop();
          return { ok: true };
        case "new_thread":
          this.agent.newThread();
          return { ok: true };
        default:
          return { ok: false, error: `Unknown tool ${name}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- agent -> voice ----------------------------------------------------

  private agentChanged(s: Snapshot) {
    const prev = this.last;
    this.last = s;
    if (!this.ready || s.status === prev.status) return;
    if (s.status === "needs-you" && s.approval) {
      this.say(`[agent update] The agent is asking permission: ${s.approval.summary}. Ask the user whether to allow it.`);
    } else if (s.status === "idle" && prev.status === "working") {
      this.say(`[agent update] The agent finished. Its final message: ${JSON.stringify(s.lastMessage)}. Summarise it briefly.`);
    } else if (s.status === "error") {
      this.say(`[agent update] The agent hit an error: ${JSON.stringify(s.lastMessage)}.`);
    } else if (s.status === "offline") {
      this.say("[agent update] The agent on the Mac went offline.");
    }
  }

  /** Put a system note into the conversation and have the model speak about it. */
  private say(text: string) {
    this.queued.push(text);
    if (!this.responding) this.flush();
  }

  private flush() {
    if (!this.queued.length || this.responding) return;
    for (const text of this.queued.splice(0)) {
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
      });
    }
    this.send({ type: "response.create" });
    this.responding = true;
  }
}
