import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const DIEL_DIR = process.env.DIEL_HOME ?? join(homedir(), ".diel");
export const PORT = Number(process.env.DIEL_PORT ?? 8791);

/** Shared secret the watch must present. Created on first run, readable only by you. */
export function loadToken(): string {
  const file = join(DIEL_DIR, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(DIEL_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

/** First private IPv4 address, preferring en0 (Wi-Fi on a MacBook). */
export function lanAddress(): string | null {
  const ifs = networkInterfaces();
  const names = Object.keys(ifs).sort((a, b) => Number(b === "en0") - Number(a === "en0"));
  for (const name of names) {
    for (const a of ifs[name] ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        return a.address;
      }
    }
  }
  return null;
}

/** Locate the codex binary: explicit override, PATH, then the desktop app bundles. */
export function findCodexBin(): string | null {
  if (process.env.DIEL_CODEX_BIN) return process.env.DIEL_CODEX_BIN;
  try {
    return execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim() || null;
  } catch {
    // not on PATH
  }
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
  return candidates.find(existsSync) ?? null;
}

/**
 * OpenAI API key for live voice: DIEL_OPENAI_KEY, or the file ~/.diel/openai_key.
 * A ChatGPT login is not an API key; this needs one from platform.openai.com.
 */
export function loadOpenAIKey(): string | null {
  if (process.env.DIEL_OPENAI_KEY) return process.env.DIEL_OPENAI_KEY.trim();
  const file = join(DIEL_DIR, "openai_key");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim() || null;
}

/** Stable id for this bridge, created on first run. */
export function loadBridgeId(): string {
  const file = join(DIEL_DIR, "id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(DIEL_DIR, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString("hex");
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

/** The Mac's user-facing name, e.g. "Yigit's MacBook Pro". */
export function macName(): string {
  if (process.env.DIEL_NAME) return process.env.DIEL_NAME;
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() || "Mac";
  } catch {
    return "Mac";
  }
}

let idleCache = { at: 0, value: 0 };
/** Seconds since the last keyboard/mouse input on this Mac (cached for a second). */
export function idleSeconds(): number {
  if (process.env.DIEL_IDLE) return Number(process.env.DIEL_IDLE);
  const now = Date.now();
  if (now - idleCache.at < 1000) return idleCache.value;
  let value = 0;
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    if (m) value = Math.floor(Number(m[1]) / 1e9);
  } catch {
    // unknown: treat as active
  }
  idleCache = { at: now, value };
  return value;
}
