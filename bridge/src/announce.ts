// Announces the bridge on the local network as a Bonjour service
// (_diel._tcp), so the watch can find every Mac running a bridge without
// knowing their addresses. Uses macOS's built-in dns-sd tool.
//
// TXT record: id (stable bridge id), v (protocol version), pair (1 while a
// pairing window is open). The name is the Mac's computer name.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export class Announcer {
  private child: ChildProcess | null = null;
  private stopped = false;
  private pairing = false;
  private name: string;
  private port: number;
  private id: string;

  constructor(opts: { name: string; port: number; id: string }) {
    this.name = opts.name;
    this.port = opts.port;
    this.id = opts.id;
    const stop = () => this.stop();
    process.once("exit", stop);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => (stop(), process.exit(0)));
  }

  start() {
    this.register();
  }

  setPairing(open: boolean) {
    if (open === this.pairing) return;
    this.pairing = open;
    this.register();
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  private register() {
    if (this.stopped) return;
    const old = this.child;
    this.child = null;
    old?.kill();
    const child = spawn(
      "/usr/bin/dns-sd",
      ["-R", this.name, "_diel._tcp", "local", String(this.port), `id=${this.id}`, "v=1", `pair=${this.pairing ? 1 : 0}`],
      { stdio: "ignore" },
    );
    this.child = child;
    child.on("exit", () => {
      // dns-sd should run for as long as the bridge does; bring it back if it dies.
      if (this.child === child && !this.stopped) setTimeout(() => this.child === child && this.register(), 5000);
    });
  }
}
