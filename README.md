# dsh-agent-restart

[English](./README.md) | [中文](./README.zh.md)

Lets DeepSeek Harness (DSH NEXT desktop) pick up unfinished work by itself after the agent restarts the app.

## What problem it solves

Restarting kills the current turn, and a new turn only starts when something triggers it. The usual choices are waiting for the human to speak again or losing context and starting over. This plugin makes restart part of the workflow:

- Record the pending work before restarting; open a fresh turn automatically afterwards, so the user never has to restate it.
- Only agent-initiated restarts trigger this. Closing and reopening the app by hand does nothing.
- The restart tool confirms the helper actually started; if it did not, it reports failure instead of a silent success.

## Compatibility

- Built for DSH NEXT desktop `2.0.17-next` (bundled `@deepseek-ai/*` at `0.2.0-rc.2`).
- Windows only: restart relies on PowerShell and WMI.
- The continuation message is queued through host services (`sessionController`, `sessions`). Those are internal interfaces and may change between DSH releases, so re-verify after upgrading. The plugin does not promise compatibility with older DSH versions; when it cannot work it reports an error instead of failing silently.

## Features

### 1. The `restart_harness` tool

- Writes a restart journal (reason, pending work, voice state, session id) and generates an external helper script.
- Creates the helper through WMI so it leaves the app's process tree: wait, kill the app, wait for exit, write a one-shot marker, then relaunch.
- After launching, checks `restart.log` to confirm the helper actually started; otherwise reports failure.

### 2. Automatic continuation after restart

- Five seconds after the app is ready (plugin apply), queues a message with source `restart` into the session and opens a new turn.
- Queued once. No goal, no completion mark, no system-prompt injection. Retries every 3 seconds, up to 6 times.
- The UI renders it as a system notice (“execution requested”), not as a user message.

### 3. Handover to the voice plugin

- Records whether voice mode was on before restart and writes `voice-resume.json` on startup.
- The voice plugin (`dsh-voice-mode-desktop`) reads that file and decides whether to restore voice mode. The two plugins install independently and do not depend on each other.

## Execution flow

1. The agent calls `restart_harness(reason, pending)`; the plugin writes `restart-journal.json`.
2. The plugin generates the helper script and creates the helper process through WMI, outside the app's process tree.
3. The helper waits, kills `DSH NEXT`, waits for exit, writes the one-shot marker `agent-restart.flag`, and relaunches the app.
4. On startup the plugin reads the journal only when the marker exists (manual launches have no marker); it writes `voice-resume.json` for the voice plugin and removes the marker.
5. Five seconds after the app is ready, the plugin queues the source-`restart` continuation message and opens a new turn.
6. The agent finishes the pending work and reports; the journal becomes `continued`.

## Integration with the voice plugin

Before restarting, the plugin records the voice state (on/off, active session id) in the journal. After restart it writes `voice-resume.json`; the voice plugin reads it on startup and restores voice mode when needed, then acknowledges and deletes the file.

So voice state survives the restart: if it was on before, it is on afterwards and you can hold to speak. Only agent-initiated restarts use this path; manual launches do not auto-restore. If the voice plugin is not installed, restart still works without voice restoration.

## Why not in-app relaunch or a community restart plugin

Restarting in-process via Electron's relaunch looks cleanest, but it is unreachable here: the plugin runs in a host subprocess without the Electron `app` object. The renderer does expose a restart command, but it shows a native confirmation dialog and must be relayed through the UI. Removing the dialog would mean patching DSH's main process — platform core, overwritten by upgrades, not worth it.

Community restart plugins were evaluated too: they ship their own watchdog process plus a token-protected HTTP route, wrapping the external-process approach in more moving parts and requiring per-version adaptation. The cost outweighs the benefit.

That leaves an external helper process created through WMI: the only restart path verified to work on this machine, and it leaves DSH core untouched so the plugin can be updated independently.

## Known limitations

- Restart needs a path outside the app's process tree. The launcher is invoked synchronously and its exit code is checked: if it exits non-zero or the helper never writes its first log line, the tool reports the exact failure instead of claiming success.
- Windows only.
- Voice restoration only happens when the voice plugin is installed.

## Install

Requirements: Windows, DSH NEXT desktop `2.0.17-next`, PowerShell and WMI available.

Option A (recommended):

1. Install the npm package: `npm install @nutshelllee/dsh-agent-restart` (or add it to the DSH profile dependencies).
2. Add `- id: agent-restart, name: "@nutshelllee/dsh-agent-restart"` to the profile's `cordis.patch.yml` insert list.
3. Restart DSH; `restart_harness` appears in the tool list.

Option B (local development): link this repository into `node_modules/@nutshelllee/dsh-agent-restart` of the profile, then follow steps 2 and 3.

## License

MIT, see [LICENSE](./LICENSE).
