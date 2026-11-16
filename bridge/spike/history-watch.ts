// Starts one turn in a desktop-owned thread via the app's IPC, then prints what
// thread/read reports for the newest turn every second until it settles.
import { CodexClient, stdioTransport } from "../src/codex.ts";
import { findCodexBin } from "../src/config.ts";
import { DesktopIpc } from "../src/desktop.ts";

const threadId = process.argv[2];
const ipc = new DesktopIpc();
const owner = await ipc.findOwner(threadId);
if (!owner) throw new Error("thread not open in the Codex app");
const c = new CodexClient(stdioTransport(findCodexBin()!));
await c.initialize();
const turnId = await ipc.startTurn(owner, threadId, process.argv[3]);
console.log("started", turnId);
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await c.request("thread/read", { threadId, includeTurns: true });
  const t = r.thread.turns.at(-1);
  console.log(
    `${i}s`, t.id === turnId ? "NEW" : "old", t.status, `completedAt=${t.completedAt}`, `items=${t.items.length}`,
    JSON.stringify(t.items.map((x: any) => [x.type, x.phase ?? "", (x.text ?? "").slice(0, 25)])).slice(0, 300),
  );
  if (t.id === turnId && t.status !== "inProgress" && t.completedAt) break;
}
process.exit(0);
