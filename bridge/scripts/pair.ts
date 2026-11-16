// Opens a two-minute window in which a watch can pair with the bridge running
// on this Mac. The watch shows a prompt; tap Pair on it.
import { PORT } from "../src/config.ts";

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/pair-mode`, { method: "POST" });
  if (!res.ok) throw new Error(`bridge answered ${res.status}`);
  const { seconds, name } = (await res.json()) as { seconds: number; name: string };
  console.log(`"${name}" is ready to pair for ${seconds} seconds.`);
  console.log("Open Diel on the watch and tap Pair when it asks.");
} catch (e) {
  console.error(`Couldn't reach the bridge on port ${PORT}: ${e instanceof Error ? e.message : e}`);
  console.error("Start it first: ./scripts/install-agent.sh (or npm start).");
  process.exit(1);
}
