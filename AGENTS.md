# AGENTS.md

Instructions for a coding agent working in this repo. The most common request is
**"install Diel on this Mac"**: follow the install runbook below. See
[README.md](README.md) for what Diel is and how it fits together.

## Ground rules

- Never print, log, commit or paste secrets: `~/.diel/token`, `~/.diel/openai_key`,
  `watch/bridge.properties`, or the bridge's `/presence` and pairing responses.
  When checking that a secret file exists, report its size and permissions, not
  its contents.
- Never ask the user to paste an API key or pairing token into chat. Give them a
  command that reads it without echoing (below).
- Ask before installing system software (Homebrew packages, the Android SDK) and
  before accepting the Android SDK licence on the user's behalf.
- Don't edit files outside this repo except `~/.diel/` and
  `~/Library/LaunchAgents/dev.diel.bridge.plist` (both written by the scripts).

## Install runbook: "install Diel on this Mac"

Work through these in order. Check each step's result before moving on, and stop
to ask the user wherever a step says **(user)**.

### 1. Check prerequisites

```bash
node --version            # needs 24 or newer (the bridge runs .ts files directly)
ls /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
ls ~/.codex/ipc/ipc.sock  # present while the Codex desktop app is running
```

- Node missing or older than 24: `brew install node` (ask first).
- Codex binary missing: **(user)** install the ChatGPT desktop app with Codex
  and sign in. The bridge can't work without it.

### 2. Install and start the bridge

```bash
cd bridge && npm install && ./scripts/install-agent.sh
```

Verify (expect `state = running`, then log lines ending in
`announced as "<Mac name>"` and `connected to codex app-server`):

```bash
launchctl print gui/$(id -u)/dev.diel.bridge | grep -E "state =|last exit"
tail -n 20 ~/.diel/bridge.log
curl -s localhost:${DIEL_PORT:-8791}/healthz   # prints ok
```

If the log says the port is in use (`EADDRINUSE`), another app already uses
8791. Pick a free port and reinstall with `DIEL_PORT=<port> ./scripts/install-agent.sh`;
the watch learns the port through discovery, so nothing else changes. Use the
same `DIEL_PORT=<port>` prefix for `npm run pair`, and tell the user.

macOS may show **(user)** "Allow node to accept incoming network connections?"
the first time. The user must click Allow, or the watch can't connect.

### 3. Live voice (optional, needs an OpenAI API key)

If `~/.diel/openai_key` doesn't exist, **(user)** ask whether they want live
voice. If yes, have them run this themselves; it prompts without echoing:

```bash
mkdir -p ~/.diel && read -s "k?OpenAI API key: " && print -r -- "$k" > ~/.diel/openai_key && chmod 600 ~/.diel/openai_key
```

Then restart the bridge with `./scripts/install-agent.sh` and check that the log
says `live voice     enabled`. A ChatGPT login is not an API key; it needs a key
with billing from platform.openai.com. Without a key the watch falls back to
dictate-and-send, which still works.

### 4. Watch app (only if it isn't installed on the watch yet)

Skip this step if the user already has Diel on their watch from another Mac:
one install serves every Mac. Otherwise the app is built and installed over
wireless adb:

1. Ask before installing: `brew install openjdk@17 && brew install --cask android-commandlinetools`,
   then (licence acceptance needs the user's OK)
   `yes | sdkmanager --licenses && sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"`.
2. **(user)** On the watch: Settings → Developer options → Wireless debugging →
   Pair new device. Ask for the IP:port and six-digit code on that screen, and
   the IP:port on the main Wireless debugging screen (it differs).
3. `adb pair <ip:pairing-port> <code>`, then `adb connect <ip:port>`.
   `adb` lives at `$(brew --prefix)/share/android-commandlinetools/platform-tools/adb`.
   mDNS can list stale addresses for the watch; trust the address the user reads
   off the watch.
4. Build and install:

   ```bash
   cd watch
   echo "sdk.dir=$(brew --prefix)/share/android-commandlinetools" > local.properties
   JAVA_HOME=$(brew --prefix openjdk@17) ./gradlew :app:installDebug
   ```

### 5. Pair the watch with this Mac

```bash
cd bridge && npm run pair
```

**(user)** Open Diel on the watch and tap **Pair** within two minutes. Confirm
with `tail ~/.diel/bridge.log` (look for `paired with ...`). Only run pairing on
a trusted network: the first watch that asks gets this Mac's token.

### 6. Check end to end

- The watch shows the pet with a blue ring (green spinning while the agent
  works). A grey ring with a sleeping pet means it can't reach a bridge.
- Long-pressing the pet lists this Mac as Nearby or Connected.
- With the Codex app open on a thread, ask the user to tap the pet and give a
  small instruction by voice, then confirm it appears in that thread.

Report what was done, what the user still needs to do, and anything you skipped.

## Updating an existing install

```bash
git pull && cd bridge && npm install && ./scripts/install-agent.sh
```

Rebuild and reinstall the watch app (step 4.4) only if files under `watch/`
changed.

## Uninstall

```bash
cd bridge && ./scripts/install-agent.sh uninstall
```

`~/.diel/` holds the token, bridge id and API key; delete it only if the user asks.

## Working on the code

- Bridge: Node + TypeScript run directly by Node (no build step). Tests:
  `cd bridge && npm test` (fake Codex app-server, desktop IPC router and Realtime
  server). Keep them passing.
- Watch: Kotlin + Compose for Wear OS, `cd watch && ./gradlew :app:assembleDebug`.
  Debug builds can be forced into a state for screenshots:
  `adb shell am start -n dev.diel.watch/.MainActivity --es demo working --es voice speaking`,
  then `adb exec-out screencap -p > shot.png`.
- `bridge/spike/` holds throwaway probes used to reverse-engineer Codex; they
  are not part of the bridge.
- The Codex desktop IPC (`bridge/src/desktop.ts`) is undocumented and may break
  with app updates. If threads open in the Codex app stop receiving instructions,
  start there.
- Microphone on Pixel Watch: use `AudioSource.VOICE_RECOGNITION`;
  `VOICE_COMMUNICATION` fails to start (status -38).
