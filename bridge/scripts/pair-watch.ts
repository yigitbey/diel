// Writes the Mac's LAN address and the shared token into the watch build
// (watch/bridge.properties, git-ignored) so nothing has to be typed on the watch.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PORT, lanAddress, loadToken } from "../src/config.ts";

const host = process.env.DIEL_HOST ?? lanAddress();
if (!host) {
  console.error("No LAN address found. Connect to Wi-Fi or set DIEL_HOST.");
  process.exit(1);
}
const out = fileURLToPath(new URL("../../watch/bridge.properties", import.meta.url));
writeFileSync(out, `host=${host}\nport=${PORT}\ntoken=${loadToken()}\n`, { mode: 0o600 });
console.log(`wrote ${out} (host ${host}, port ${PORT})`);
console.log("Rebuild and reinstall the watch app for this to take effect.");
