# Archon Desktop — build notes

Handoff spec for the agent implementing this. The prototype is `Archon Desktop v2.dc.html`
(v1, `Archon Desktop.dc.html`, is kept only as the earlier direction — build v2).
Everything below describes intended product behaviour; the prototype fakes data and I/O.

---

## 1. What it is

A single-operator desktop client for Archon, one agent running on a personal VPS.
The **server owns the work**: sessions and tasks keep running when the window closes.
The desktop app is a viewer and dispatcher, never the executor.

- Client: Electron (or Tauri) shell, one renderer window, custom titlebar (`frame: false`).
- Backend: the existing Python service on the VPS, bound to `127.0.0.1:8787`, reached over
  Tailscale only. No public port.
- Auth: device token in the OS keychain via `safeStorage`. No password screen in the app.
- Transport: REST for commands, SSE for the event stream (ordered, replayable by cursor).
  Client never polls for state.

---

## 2. Screens (all present in the prototype)

| View | `state.view` | Notes |
| --- | --- | --- |
| Start | `new` | Mark + wordmark + live strip + composer over the background plate |
| Thread | `thread` | Session transcript, tool calls, diffs, right-side bench panels |
| Chat | `chat` | Day-to-day conversations. **No tools, no shell, no file writes** |
| Sessions | `sessions` | All sessions, sortable (recent / project / status / msgs) + direction toggle |
| Projects | `projects` | Project cards; each project has its own sessions page |
| Project | `project` | One project: its sessions, descending by default |
| Tasks | `tasks` | Background work + status, each links to its session |
| Skills / Automations / Backups / Logs | `skills` `automations` `backups` `logs` | Sidebar, under Projects |
| Settings | `settings` overlay | Tabs: General, Connection, Models, Appearance, Language, Brand, About |

Sidebar order (top to bottom): version badge → New session → search → **Chat**, Sessions,
Tasks → Projects (each expandable to its own sessions, descending) → Skills, Automations,
Backups, Logs → account row.

---

## 3. Sessions vs chats vs tasks

- **Session** — agent work in a project directory. Has a working dir, model, tool log, cost,
  and a server-side process group. Survives client restart.
- **Chat** — conversation only. Same model, no tools bound, nothing written to disk.
  Cheap to start, listed by day (Today / Yesterday / Earlier).
- **Task** — a unit of background work belonging to a session; states `working`, `queued`,
  `failed`, `finished`. The Tasks page is the truth for "what is running right now".

Decomposition: a request may become one task or several (see the triage rules the agent
already follows). The UI must show the parent session for every task.

---

## 4. Approval modes (composer, cycles in this order)

1. **Auto** — runs every step without asking.
2. **Approve steps** — asks before each tool call, edit or command.
3. **Plan mode** — researches and writes a plan; no edits or commands until accepted.

The mode is per session, persisted with the session, and shown lit in the composer at all
times (never a dim "off" state). Hideable in Settings → General → Composer controls.

## 5. Voice

Two separate things, both in the composer, both hideable by the same setting:

- **Mic** — dictation for one prompt. While recording, the glyph becomes the animated wave.
- **Wave** — a live voice conversation with the agent (speech in, speech out). Active state
  shows a tinted chip reading `Live` with animated bars.

## 6. Cancel semantics (the bug this app exists to fix)

Runners are spawned with `start_new_session=True`, so cancel signals the whole process group:
`SIGTERM` to `-pgid`, wait 5s, then `SIGKILL`. Reconcile DB state only after `wait()` returns —
never optimistically. File writes are atomic (temp + rename) so a killed runner cannot leave a
half-written file. Backend restart returns running tasks to the queue.

---

## 7. Theming system

Seven themes, defined as flat token sets: `obsidian` (default), `indigo`, `carbon`, `ivory`,
`blueprint`, `moss`, `ember`. Each carries `bg, surface, text, accent, side, panel, edge,
hover, chip, aChip, rad, fh, fb, dark`. Everything else is derived with `color-mix`.

Independent overrides, all in Settings → Appearance, all persisted in `settings.json`:

- **Interface face** — 27 families. Default Chivo.
- **Display face** — 34 families, wordmark only. Default Playfair Display 800; each pick
  carries its own weight and tracking.
- **Type colour** — interface ink (Theme / Warm / Cool / Tinted / Softer) and wordmark tone
  (Tinted / Ink / Accent / Ghost / Outline) separately.
- **App mark** — 22 built-in marks, or an uploaded PNG/SVG. One selection drives titlebar,
  sidebar, reply avatars, tray, packaging and the Brand tab.
- **Background library** — see below.
- **Surface** — ambient effect (none / halo / aurora / mesh / grid), glass panels on/off.
- **Metrics** — scale, radius, density, motion sliders.

## 8. Background library (persist this properly)

- Backgrounds are **files on disk**, not blobs in a config value:
  `~/.archon/backgrounds/<uuid>.<ext>`, and `settings.json` records
  `{ id, label, file, addedAt }` plus the active selection.
- The library ships one plate (`assets/home-backdrop.png`, the engraved ruins) and offers
  three user slots. Dropping an image copies it into the backgrounds folder — the original
  path is never referenced.
- Per-background render settings, also persisted: `fit` (`cover` / `contain` / `tile`) and
  `strength` (20–100%). Dark themes render at full strength; light themes multiply at half.
- `Show background` toggle only hides the layer; it must not clear the selection.
- Same treatment for the uploaded **app mark**: copy to `~/.archon/brand/mark.<ext>`.

---

## 9. Chrome details worth copying exactly

- Titlebar 36px: sidebar toggle, breadcrumb, bench tabs (Activity / Files / Terminal, ⌘1–⌘3),
  window buttons. Close hovers red.
- Version badge in the sidebar opens the update dialog: version, size, tagged change list
  (`fix` / `new` / `ui`), a line stating running tasks survive, then **Cancel** and
  **Update and restart**.
- Logs page: merged backend / runner / cron / auth / backup lines, level-coloured, filter
  pills, and **Copy all** which writes the *filtered* set to the clipboard as plain text.
- Command palette ⌘K over everything; Esc closes palette, dialogs, settings and the updater.
- Shortcuts: ⌃N new session, ⌘K palette, ⌘, settings, ⌃⇧M models, ⌘\ sidebar, ⌘1–3 bench.
- RTL: Arabic mirrors the whole layout (sidebar right, icons flip) but paths, code and
  identifiers stay LTR inside Arabic text. Use logical properties everywhere —
  `margin-inline-*`, `inset-inline-*`, `border-inline-*`. No `left`/`right`.

## 10. Mocked in the prototype — real work for you

- All sessions, chats, tasks, logs, backups, automations and skills are static fixtures.
- Sliders in Metrics are visual only.
- Import/Export JSON and "Save as custom theme" are stubs; wire to `settings.json`.
- Model picker lists models but does not switch anything.
- Send, dictate and voice do not transmit; they only toggle UI state.

## 11. Non-negotiables

1. Nothing may block on the window being open — the server is the source of truth.
2. Cancel must be honest: never report cancelled before the process group is reaped.
3. Chat must be unable to touch the filesystem, even by mistake — separate code path.
4. Every appearance choice persists and survives an update; the theme never resets itself.
5. One agent. No specialist roster, no team abstractions in the UI.
