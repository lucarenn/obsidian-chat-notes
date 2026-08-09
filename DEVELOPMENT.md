# Chat Notes — developer notes

Internal notes on how the plugin is built. `README.md` covers what it does for users;
`AGENTS.md` covers generic Obsidian plugin tooling. This file covers *this* codebase:
the flow, the structure, and a few non-obvious solutions that are easy to break
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
   `chat-message`, and listeners on `active-leaf-change` (move the chat input),
   `workspace.resize` + `layout-change` (reposition it — `layout-change` is the only one that
   fires on a mode switch), `metadataCache.changed` (refresh the model, then the config), and
   `vault.rename` / `vault.delete` (drop the model and re-key the reply target).
2. Obsidian calls the **codeblock processor once per message block**. It:
   - bails to a plain `<pre>` if the file isn't a chat note,
   - gets the file's `ArchiveContext` (see below),
   - looks the block up by the id on its first line (`extractMessageIdFromSource`), falling
     back to parsing the block out of `source` if the model hasn't seen it yet,
   - builds the DOM (`createElementsHTML`), appends it, then renders the body with
     `MarkdownRenderer.render`.
3. The first message to render for a file also triggers `applyConfigToFile`, which pushes
   the resolved config onto the view containers as CSS custom properties. Later messages
   skip it (`note.lastAppliedConfig !== note.configCache`) and inherit through the cascade.

### The two per-file caches

They differ in **lifetime**, and that is the whole design:

- **`ArchiveContext`** (`archiveContexts: Map<path, Promise<ArchiveContext>>`) — the parsed
  file, and *only* what is derivable from its text: `messageMap` (id →
  `{ message, startLine, endLine }`) plus derived `authors`, `lastAuthor`, `maxMessageId`,
  `pinnedMessagesAmount`. **Disposable**: replaced wholesale whenever the file changes
  (`invalidateArchiveContext`, driven by `metadataCache.on("changed")`, which hands over the
  new text so a rebuild costs a parse and no read).
  *A **promise** is cached, not the value*: the codeblock processor runs concurrently for
  every visible message, and caching the value would build one context per message.
  Nothing mutates a context after construction except `applyConfigToContext` — that is what
  makes throwing it away safe, since a caller holding an older one across an `await` still
  sees a consistent snapshot.
- **`ChatNote`** (`WeakMap<TFile, ChatNote>`) — per-file **UI** state: unsent input text,
  resolved config cache, last seen frontmatter, `replyTo`, and `pinFilter`. This is what the
  user did rather than what the file says, so it must outlive a context rebuild (i.e. every
  save) and a rename. **If you add state, this is usually where it belongs.**

### Two things deliberately *not* cached

- **Rendered nodes.** A message has one row per place it is rendered — reading view and live
  preview are both mounted, and the same note can be open in several leaves — so a single
  stored reference is wrong by construction and goes stale on every re-render. Rows carry
  `data-msg-id` / `data-chat-src` / `data-pinned` and are found by querying:
  `findMessageRows`, `collectMessageRows` in `util.ts`. This also inverts the loop in the
  styling sweep: it walks what is on screen, not every message in the file.
  The search runs **from the document down**, not over the containers of open leaves —
  Obsidian renders chat blocks in more places than those (embeds, hover popovers, canvas,
  popout windows), and a sweep that misses one leaves a stray row behind. `data-chat-src` is
  what keeps a document-wide search correct.
- **Line numbers for writes.** `startLine`/`endLine` are a *scroll hint only*. Every write
  goes through `withMessageBlock`, which re-locates the block by id in the exact text it is
  about to modify — see the quirks below.

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

**Off-screen messages have no row.** Both view modes only render near the viewport, so a
message far away has no node at all. `scrollToMessage` therefore jumps to its *source line*
first (`setEphemeralState`), which mounts it via the codeblock processor, then polls
`waitForMessageRow` before scrolling precisely.

**Writes locate their block by id, in the text they are about to modify.** `withMessageBlock`
is the single write path. It never trusts a cached line number: any edit above a message
shifts it, and the model can lag the file by a metadata-cache debounce, so a write keyed off
`entry.startLine` could seek a *different* message's header separator and splice into it.
It also reads through the open editor when there is one — an editor with unsaved changes has
not reached disk, so `vault.read` would return superseded text and the write would clobber
what the user just typed. `vault.process` is the atomic fallback.

**A write refreshes the model itself, *before* writing.** The metadata cache is debounced by
roughly the editor's save delay, but writing through the editor re-renders the changed block
almost at once — and the processor builds that row from the model. Leave the model behind and
the row comes back describing the state *before* the write (old bubble colour, and a
`data-pinned` the pinned-only filter then believes), correcting itself a suspicious two
seconds later.

The ordering is load-bearing, not incidental. Refreshing *after* the write is not enough: the
processor is `async`, so the re-render calls `getArchiveContext`, yields on that promise, and
resumes holding the context it captured — the pre-write one. A sweep running in between can't
help either, because the row it would need to fix doesn't exist yet. `withMessageBlock` has
the new text before it writes, so it hands that to `invalidateArchiveContext` first and every
render the write provokes reads the new model.

**A write must not move the reader.** CodeMirror scrolls the selection into view on a document
change, and replacing a block re-creates its widget — together they jump the view to wherever
the caret happens to sit, which after a button click is usually elsewhere in the note. The
editor branch captures `getScrollInfo()` and restores it, twice: immediately, and again on the
next frame, since the re-created widget can resize as it renders. Reading View never sees this
because it has no editor and takes the `vault.process` branch.

**An unknown message id is not an error.** `source` *is* the block, so a message the model
hasn't seen — typed by hand, pasted, or appended a moment ago — is parsed straight from it.
Live Preview re-runs the processor on every keystroke while a block is being typed, so
throwing (or rebuilding the model) there fired once per character.

**Scroll-on-send can't wait for the render.** The write only *schedules* the processor, and
waiting for the new message to render deadlocks, since it renders *because* something scrolled
to it. So `scrollToBottomAfterSend` scrolls immediately and keeps re-scrolling on
`requestAnimationFrame` for 500 ms, dragging the render along.

**The next id is allocated inside the write.** `appendMessage` wraps the whole read-modify-
write in `vault.process` and derives the id from *that* text, not from the cached model —
two sends inside the metadata debounce would otherwise both see the same highest id and
collide.

**Row vs bubble — the row is the identity.** `.chat-message-row` wraps the bubble
(`.chat-message`) along with the reply button and the author badge. The row is what carries
the data attributes (`data-msg-id`, `data-chat-src`, `data-pinned`), what per-message CSS
variables are set on, and what state is expressed against — the CSS then reaches down to the
bubble where a bubble-shaped effect is wanted. Variables have to live on the row because the
badge and its tail are *siblings* of the bubble and would never inherit from it; the tail has
to be a sibling because the bubble's own `overflow: hidden` (which clips the reply banner to
its rounded silhouette) would cut it off.

`chat-message-scroll-highlight` is the one remaining state *class* on the row, and it can be:
it is transient (900 ms), so nothing has to survive an unmount. Everything durable is a data
attribute or a generated rule, for the reason two entries below.

**Borders are `box-shadow`.** `overflow: hidden` clips an element's children but never its
own border, so a real border would show through as a ring behind the flush reply banner.
Same trick on the bubble and the input container.

**Settings apply without a rerender.** Author/timestamp visibility and the author badges are
always *built*, and only shown or hidden by a class on the container. That is what lets a
settings or YAML change take effect on messages already on screen.

**Live Preview re-inserts cached rows without re-running the processor.** CodeMirror unmounts
block widgets that scroll far off screen and, when they scroll back, re-inserts *the DOM it
kept* — the codeblock processor does not run again. So any per-row state applied by walking
the DOM is doubly unreliable there: rows that were unmounted during the walk never get it,
and rows that were walked come back carrying whatever they had at unmount time. Symptom: a
sweep appears to work on "random" messages.

The rule that follows: **per-message view state belongs on the row as data, with the switch
on the container, and the decision left to CSS.** The pinned-only filter is the worked
example — each row carries `data-pinned` from render, the container carries `.msg-pinned-only`,
and `styles.css` matches the two. Nothing sweeps, so mount timing stops mattering. Prefer
this over `classList.toggle` in a loop whenever the state has to hold for messages that are
not currently on screen.

**When the state can't be expressed statically, generate the selector.** The reply target is
the case the pattern above can't cover: "which row is the target" changes at runtime, and CSS
cannot compare a container's attribute against a row's. So `refreshReplyTargetStyle` maintains
one plugin-owned `<style>` element holding a rule per pending target, keyed on
`data-chat-src` + `data-msg-id`. The rule carries **no appearance** — it only raises
`--msg-reply-outline` / `--msg-reply-btn-opacity` / `--msg-reply-btn-events`, which
`styles.css` consumes, so the look stays in one place. Because it is a rule and not a class,
it applies to a row the instant that row is mounted, including a cached re-insert, and stops
applying the instant the target changes — no row is ever visited.

This knowingly breaks `obsidianmd/no-forbidden-elements` (disabled inline, with the reasoning
at the call site). That rule targets plugins shipping styling from JS; the alternative here
would be re-asserting a class from a MutationObserver, at the cost of a document-wide query
on every frame the DOM churns.

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

**Writes go through the editor when there is one, never `setValue`.** `withMessageBlock`
prefers `editor.replaceRange` on the *target file's* view — it preserves undo history and the
caret, and rewriting the whole document (`setValue`) would also rewrite the frontmatter, which
fires the metadata listener and forces a full rerender. Resolve the view by
`view.file?.path === file.path`, never `getActiveViewOfType`: the delete and edit handlers
used to grab the *focused* editor, so acting on a message in a background leaf could write one
file's content into another's.

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

