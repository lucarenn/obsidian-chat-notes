# Chat Notes — developer notes

Internal notes on how the plugin is built. `README.md` covers what it does for users;
`AGENTS.md` covers generic Obsidian plugin tooling. This file covers *this* codebase:
the flow, the structure, and a few of non-obvious solutions that are easy to break
by accident.

## Getting set up

```bash
npm install
npm run dev     # esbuild watch -> main.js
npm run build   # tsc -noEmit + production bundle
npm run lint
```

Shipped artifacts are `main.js`, `manifest.json` and `styles.css` — nothing else is read at
runtime. Reload the plugin (or the vault) to pick up a build.

Working directly in a test vault's `.obsidian/plugins/obsidian-chat-plugin` is the shortest
loop: `npm run dev` then writes `main.js` straight to where Obsidian loads it, with no copy
step in between.

## The file format

A chat note is an ordinary markdown file with `type: chat` in its frontmatter. Every
message is one fenced block:

`````text
````chat-message
id: 12
author: Alice
timestamp: 06.08.2026 14:33
pinned: true
reply_to: 9
~~~
The message body, rendered as markdown.
````
`````

- **Four backticks**, so a message body can contain ordinary three-backtick code blocks.
- Header is `key: value` lines until the `~~~` separator. `id`, `author` and `timestamp`
  have real slots on `Header`; everything else lands in `Header.extra` and round-trips
  untouched, that is how `pinned` and `reply_to` are stored without a format change.
- The body is normalised to open and close with a blank line, which is what makes
  `fromString` → `toString` stable.
- **Ids are decimal strings, never numbers.** The plugin was built to hold imported
  Discord exports, and a 19-digit snowflake exceeds what a JS number holds exactly —
  `Number(maxId) + 1` would silently reuse or skip an id. `compareNumericIds` /
  `incrementNumericId` in `util.ts` do the arithmetic digit by digit.

## Source layout

| File | Contains |
| --- | --- |
| `main.ts` | The `Plugin` class: commands, events, the codeblock processor, config/style application, message writes |
| `ui.ts` | All DOM building — chat input, message bubble, action menu, inline editor, reply banners, author badges |
| `types.ts` | `Message` / `Header` (the file format), `ArchiveContext` (parsed file), `ChatNote` (per-file UI state) |
| `settings.ts` | `ChatConfig` + settings interface, defaults, the settings tab, YAML override parsing |
| `util.ts` | File-format parsing, id arithmetic, timestamps, colour contrast, scrolling helpers |
| `sticky.ts` | Manual `position: sticky` for gutter elements (see quirks) |
| `modals.ts` | Delete-confirmation modal |
| `styles.css` | All styling; consumes the `--settings-*` custom properties set from `main.ts` |

## How a chat note renders

1. `onload` registers the commands, the settings tab, a markdown codeblock processor for
   `chat-message`, and listeners on `active-leaf-change` / `metadataCache.changed`.
2. Obsidian calls the **codeblock processor once per message block**. It:
   - bails to a plain `<pre>` if the file isn't a chat note,
   - gets the file's `ArchiveContext` (see below),
   - looks the block up by the id on its first line (`extractMessageIdFromSource`),
   - builds the DOM (`createElementsHTML`), appends it, then renders the body with
     `MarkdownRenderer.render`.
3. The first message to render for a file also triggers `applyConfigToFile`, which pushes
   the resolved config onto the view containers as CSS custom properties. Later messages
   skip it (`note.lastAppliedConfig !== note.configCache`) and inherit through the cascade.

### The two per-file caches

- **`ArchiveContext`** (`archiveContexts: Map<path, Promise<ArchiveContext>>`) — the parsed
  file. `messageMap` maps id → `{ message, startLine, endLine, element }`, plus derived
  `authors`, `lastAuthor`, `maxMessageId` and the pinned count. Built lazily by reading and
  parsing the whole file once.
  *A **promise** is cached, not the value*: the codeblock processor runs concurrently for
  every visible message, and caching the value would build one context per message.
- **`ChatNote`** (`WeakMap<TFile, ChatNote>`) — per-file UI state that survives file
  switches: unsent input text, resolved config cache, last seen frontmatter, and `replyTo`
  (the message the next send will reply to).

### Config resolution

`DEFAULT_SETTINGS` → `data.json` (global settings) → per-file YAML overrides
(`getFileOverrides` maps YAML aliases such as `msgColor` to `ChatConfig` keys) →
`resolveConfig` merges, dropping `undefined`. The result is cached on the `ChatNote` and
lands in two places:

- **`applyStyles`** — anything visual, written as CSS custom properties (`--settings-msg-*`)
  or classes on the *view container*, so the cascade reaches every message at once.
- **`applyConfigToContext`** — the non-CSS values (`chatAuthor`, `defaultAuthorMode`) that
  the message-building code reads directly.

Only a YAML value that actually parses counts as an override; a typo or an empty key falls
through to the global setting rather than silently meaning `false`/`0`.

## Quirks and tricks

**Two view modes.** Reading View has a flat DOM; Live Preview mounts each
message as a CodeMirror block widget inside nested flex containers. Nearly every awkward
piece of this codebase exists because something has to behave the same in both.

**`position: sticky` doesn't work** — it's fine in Reading View and inert in Live Preview.
`sticky.ts` reimplements it by tracking scroll: one shared listener + `IntersectionObserver`
per scroller, recomputing only rows currently on screen. The author badge uses that shared
registry; the reply icon (`attachStickyReplyIcon` in `ui.ts`) keeps its own listeners, since
it is only visible while its row is hovered, so at most one row is ever tracked.

**Off-screen messages have no element.** Both view modes only render near the viewport, so
`entry.element` is missing or detached for anything far away. `scrollToMessage` therefore
jumps to the message's *source line* first (`setEphemeralState`), which mounts it via the
codeblock processor, then waits for the render before scrolling precisely.

**Scroll-on-send can't wait for the render.** `vault.modify` only *schedules* the processor,
and waiting for the new message to render deadlocks, so it renders *because* something
scrolled to it. So `scrollToBottomAfterSend` scrolls immediately and keeps re-scrolling on
`requestAnimationFrame` for 500 ms, dragging the render along.

**`appendMessage` registers the entry before writing.** `vault.modify` reruns the codeblock
processor, which throws if the context has no entry for the block it's rendering.

**Row vs bubble.** `entry.element` is the bubble (`.chat-message`); its parent
`.chat-message-row` also holds the reply button and the author badge. Per-message CSS
variables are set on the **row**, because the badge and its tail are *siblings* of the
bubble and would never inherit a property set on the bubble itself. The tail has to be a
sibling: the bubble's own `overflow: hidden` (which clips the reply banner to its rounded
silhouette) would otherwise cut it off.

**Borders are `box-shadow`.** `overflow: hidden` clips an element's children but never its
own border, so a real border would show through as a ring behind the flush reply banner.
Same trick on the bubble and the input container.

**Settings apply without a rerender.** Author/timestamp visibility and the author badges are
always *built*, and only shown or hidden by a class on the container. That is what lets a
settings or YAML change take effect on messages already on screen.

**Text contrast is computed.** The bubble colour is arbitrary user input, so
`getReadableTextColor` picks black or white and exposes it as `--settings-msg-text-color`,
which the header, action icons, badge and rendered markdown all read. It parses colours by
assigning them to a canvas `fillStyle` (twice, over two different sentinels, since a
rejected value leaves the previous one in place) — that accepts any colour CSS accepts, not
just hex.

**One gutter variable drives the layout.** `--msg-reply-gutter` sets the bubble margins, the
reply button width, and the chat input's own width/left maths (read back off the DOM in
`updateChatInputPosition`). Turning on author badges just widens that one variable.

**One chat input element exists**, created lazily and moved between views on file switch,
hidden for non-chat files. Its text is cached per file on the `ChatNote`.

**CSS variables are prefixed `--chat-input-*`, not `--input-*`** — Obsidian's own theme
defines `--input-radius` / `--input-border-width` globally, and reusing those names reskins
all of Obsidian's UI.

**Hotkeys go through `Scope`.** Obsidian's global keymap can swallow `Mod+Enter` before a
plain `keydown` listener sees it, so the input pushes its own `Scope` while focused. `Mod+Up`
needs this doubly — it is globally bound to "Scroll to Top" and only means "open the header
row" while the input or a header field has focus.

**The inline editor uses `editor.replaceRange`, not `setValue`.** Rewriting the whole
document also rewrites the frontmatter, which fires the metadata listener and forces a full
rerender.

**The 300 ms delay in `onYAMLChange`** (before a full rerender on a chat-status change) is
there to avoid an error in the embed-link plugin; it isn't arbitrary.

## Adding a setting

1. `settings.ts`: add the key to `ChatConfig` (only if it should be YAML-overridable), to
   `ChatNotesPluginSettings`, and to `DEFAULT_SETTINGS`.
2. Add its control to `ChatNotesSettingTab.display()`.
3. If overridable: map a YAML alias in `getFileOverrides`, through `parseBooleanOverride` /
   `parsePixelOverride` so a bad value falls back instead of breaking.
4. Consume it — visual settings in `applyStyles` (a CSS variable or a container class),
   plain values in `applyConfigToContext`.
5. Document it in the README's override table, and consider adding it to the commented-out
   block in `buildChatNoteFrontmatter`.

`saveSettings` already re-resolves every file's config and refreshes open files, so nothing
else has to be wired up.

