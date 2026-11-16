// Finds out how this Mac's Codex install can be attached to, and prints the
// DIEL_CODEX_URL (if any) to use for live sync with the desktop app.
//
//   npm run spike
//
// Tries, in order:
//   1. control sockets the desktop app exposes under ~/.codex
//   2. the bundled/installed codex binary over stdio (always-works fallback)

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexClient, stdioTransport, wsTransport } from "../src/codex.ts";
import { findCodexBin } from "../src/config.ts";

function findSockets(dir: string, depth = 3): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isSocket()) out.push(p);
    else if (st.isDirectory() && !["sessions", "log", "logs", "node_modules"].includes(name)) out.push(...findSockets(p, depth - 1));
  }
  return out;
}

async function tryClient(label: string, make: () => Promise<CodexClient> | CodexClient) {
  process.stdout.write(`\n${label}\n`);
  let client: CodexClient | null = null;
  try {
    client = await make();
    const init = await client.request("initialize", { clientInfo: { name: "diel_probe", title: "Diel probe", version: "0" } }, 8000);
    client.notify("initialized");
    console.log("  initialize ok:", JSON.stringify(init).slice(0, 160));
    const list = await client.request("thread/list", { limit: 5 }, 8000);
    const threads = list?.data ?? [];
    console.log(`  thread/list ok: ${threads.length} thread(s)`);
    for (const t of threads) console.log(`    ${t.id}  status=${JSON.stringify(t.status)}  ${String(t.name ?? t.preview ?? "").slice(0, 50)}`);
    return true;
  } catch (e) {
    console.log("  failed:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    client?.close();
  }
}

const bin = findCodexBin();
console.log("codex binary:", bin ?? "NOT FOUND (install the Codex app, or set DIEL_CODEX_BIN)");
if (bin) {
  try {
    console.log("version:", execFileSync(bin, ["--version"], { encoding: "utf8" }).trim());
  } catch {
    // ignore
  }
}

const sockets = findSockets(join(homedir(), ".codex"));
console.log(`control sockets under ~/.codex: ${sockets.length ? "" : "none"}`);
const live: string[] = [];
for (const s of sockets) {
  if (await tryClient(`socket ${s} (WebSocket framing)`, async () => new CodexClient(await wsTransport(s)))) live.push(s);
}

const stdioOk = bin ? await tryClient("own app-server over stdio", () => new CodexClient(stdioTransport(bin))) : false;

console.log("\n--- result ---");
if (live.length) {
  console.log("Live attach available. Start the bridge with:");
  console.log(`  DIEL_CODEX_URL=${live[0]} npm start`);
} else if (stdioOk) {
  console.log("No shared server found. The bridge will run its own app-server on the same ~/.codex:");
  console.log("  it can see and steer threads, but turns sent from the watch appear in the desktop");
  console.log("  window only after reopening the thread. For live sync, enable remote control in the");
  console.log("  Codex app (Settings > Connections) and run this probe again.");
} else {
  console.log("Could not talk to Codex at all yet.");
}
process.exit(0);
