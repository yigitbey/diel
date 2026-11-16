// Talks to the Codex desktop app's local IPC router (~/.codex/ipc/ipc.sock):
// 4-byte little-endian length + JSON frames. Read-only: registers, asks who
// owns a thread, and prints broadcasts for a few seconds.
import net from "node:net";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const threadId = process.argv[2];
const sock = net.connect(`${homedir()}/.codex/ipc/ipc.sock`);
const send = (o: object) => {
  const b = Buffer.from(JSON.stringify(o));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  sock.write(Buffer.concat([h, b]));
};
let buf = Buffer.alloc(0);
let clientId = "";
const seen: Record<string, number> = {};
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0);
    const m = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (m.type === "broadcast") {
      seen[m.method] = (seen[m.method] ?? 0) + 1;
      if (seen[m.method] <= 3) console.log("broadcast", m.method, "v" + m.version, JSON.stringify(m.params).slice(0, 700));
      continue;
    }
    if (m.type === "client-discovery-request") {
      send({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } });
      continue;
    }
    console.log("<-", JSON.stringify(m).slice(0, 700));
    if (m.method === "thread-owner-discovery" && m.resultType === "success" && process.env.SEND) {
      send({
        type: "request", requestId: randomUUID(), sourceClientId: clientId, version: 2, targetClientId: m.handledByClientId,
        method: "thread-follower-start-turn", timeoutMs: 20000,
        params: { conversationId: threadId, turnStart: { request: { threadId, clientUserMessageId: randomUUID(), input: [{ type: "text", text: process.env.SEND, text_elements: [] }] }, context: {} } },
      });
    }
    if (m.method === "initialize" && m.resultType === "success") {
      clientId = m.result.clientId;
      if (threadId)
        send({ type: "request", requestId: randomUUID(), sourceClientId: clientId, version: 1, method: "thread-owner-discovery", params: { hostId: "local", conversationId: threadId } });
    }
  }
});
sock.on("connect", () => send({ type: "request", requestId: randomUUID(), method: "initialize", params: { clientType: "diel-bridge" } }));
sock.on("error", (e) => console.log("error", e.message));
setTimeout(() => { console.log("broadcast counts", seen); process.exit(0); }, Number(process.env.WAIT ?? 8000));
