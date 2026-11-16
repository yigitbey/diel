# Diel

A Pixel Watch companion for the Codex agent running on a Mac. The watch shows a
pixel pet whose ring tracks what the agent is doing; tap it to talk to the agent
by voice, and it passes your instructions on and tells you when the agent is done
or needs permission.

```
Pixel Watch app  ⇄  Wi-Fi (token)  ⇄  bridge on the Mac  ⇄  Codex (app-server, desktop app IPC)
                                           ⇅
                                  OpenAI Realtime (live voice)
```

## Pieces

- `bridge/`: Node service on the Mac (port 8791). Talks to Codex through its
  app-server, and to threads open in the Codex desktop app through the app's
  local IPC socket. Relays watch audio to an OpenAI Realtime voice that drives
  the agent with tools.
- `watch/`: Wear OS app (Kotlin, Compose). One button: the ring is the agent's
  state, the pet inside acts it out, and tapping starts or ends a live voice
  conversation.

## Setup

1. Bridge, on each Mac: `cd bridge && npm install`, then `./scripts/install-agent.sh`
   to run it at login (logs in `~/.diel/bridge.log`; `./scripts/install-agent.sh uninstall`
   removes it). `npm start` runs it in the foreground instead.
2. Live voice: put an OpenAI API key in `~/.diel/openai_key` (mode 600) and
   rerun `./scripts/install-agent.sh`. Without one, the watch falls back to
   dictate-and-send.
3. Watch app, once: build and install over wireless adb with
   `cd watch && ./gradlew :app:installDebug`.
4. Pair the watch with a Mac: run `npm run pair` in `bridge/` on that Mac, open
   Diel on the watch, and tap **Pair**. Repeat on every Mac you use; no rebuild
   needed.

## Several Macs

Each bridge announces itself on the network (Bonjour, `_diel._tcp`), so the watch
finds paired Macs even when their addresses change. In **Auto** (the default)
the watch talks to the paired Mac you used most recently: it moves once the
current Mac has been untouched for 45 seconds and another one was used more
recently, and never in the middle of a live conversation. Long-press the pet to
pick a Mac yourself, go back to Auto, or long-press a Mac to forget it.

The mock watch page at http://localhost:8791/ (served only to this Mac) lets you
test the bridge without the watch.

## Tests

`cd bridge && npm test` runs the bridge against fake Codex, desktop-IPC and
Realtime servers.

## Caveats

- The desktop app's IPC is undocumented and may change with app updates; the
  bridge then falls back to its own app-server, which cannot write to threads
  the desktop app has open.
- For threads open in the desktop app, permission prompts are answered in the
  app, and progress is read from saved history every few seconds.
- The watch mutes its mic while the voice speaks (no echo cancellation outside
  calls), so you can't interrupt it mid-sentence.
- Pairing hands the Mac's token to the first watch that asks within the
  two-minute window, so only run `npm run pair` on a network you trust.
