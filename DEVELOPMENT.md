# Chat Notes — developer notes

Internal notes on how the plugin is built. `README.md` covers what it does for users;
`AGENTS.md` covers generic Obsidian plugin tooling. This file covers the codebase:
the flow, the structure and a few non-obvious solutions that are easy to break
by accident.

## Getting set up

```bash
npm install
npm run dev     # esbuild watch -> main.js
npm run build   # tsc -noEmit + production bundle
npm run lint
npm test        # vitest, the file-format layer (npm run test:watch to iterate)
```

Shipped artifacts are `main.js`, `manifest.json` and `styles.css` — nothing else is read at
runtime. Reload the plugin (or the vault) to pick up a build.

Working directly in a test vault's `.obsidian/plugins/chat-notes` is the shortest
loop: `npm run dev` then writes `main.js` straight to where Obsidian loads it, with no copy
step in between.

## The file format

A chat note is an ordinary markdown file with `type: chat-note` in its frontmatter. Every
message is one fenced block:

`````text
````chat-message
id: 12
author: Alice
timestamp: 06.08.2026 14:33
pinned: true
reply_to: 9
reactions: 👍 3, ❤️
~~~
The message body, rendered as markdown.
````
`````

- **Four backticks**, so a message body can contain ordinary three-backtick code blocks.
- Header is `key: value` lines until the `~~~` separator. `id`, `author` and `timestamp`
  have real slots on `Header`; everything else lands in `Header.extra` and round-trips
  untouched, that is how `pinned`, `reply_to` and `reactions` are stored without a format change.
- **Reactions** are one line of comma-separated entries in the order first added: a token
  (anything without whitespace or a comma, so imported custom emoji fit as `:name:`) and an
  optional count, 1 when omitted. The line is removed when the last reaction goes.
  `src/reactions.ts` owns parsing and serialising; read them through `readReactions`.
- The body is normalised to open and close with a blank line, which is what makes
  `fromString` → `toString` stable.
- **Ids are decimal strings, never numbers.** The plugin was built to hold imported
  Discord exports, and a 19-digit snowflake exceeds what a JS number holds exactly —
  `Number(maxId) + 1` would silently reuse or skip an id. `compareNumericIds` /
  `incrementNumericId` in `util.ts` do the arithmetic digit by digit.

## Tests

`npm test` (vitest) covers the **file-format layer only** — the code that turns a user's note into
messages and back. That scope is deliberate: the plugin rewrites files the user cannot easily
reconstruct, so the functions worth pinning down are the ones whose bugs are silent and
destructive, not the ones whose bugs are visible on screen.

| File | Covers |
| --- | --- |
| `tests/message-format.test.ts` | `Message` / `Header` round-trip, blank-line preservation, header key order, `parseMessages`, `findMessageBlocks` |
| `tests/numeric-ids.test.ts` | `compareNumericIds` / `incrementNumericId` at 19-digit snowflake length |
| `tests/renumber.test.ts` | `renumberMessageIds` — the 1..N rewrite, `reply_to` remapping, duplicates |
| `tests/reactions.test.ts` | Reaction parsing/serialising, add/remove, `setHeaderField` |
| `tests/search.test.ts` | `parseSearchQuery` / `messageMatches` (text and `key:value` filters), the date parsing, the field's suggestions |
| `tests/fixtures.ts` | `block()` / `note()` builders for chat-note text |

Two things to know before adding to them:

- **`tests/stubs/obsidian.ts` is not a mock.** The `obsidian` package is types-only (`"main": ""`),
  so a runtime `import { MarkdownView } from "obsidian"` has nothing to resolve to outside the app;
  `vitest.config.ts` aliases the module to that stub purely so `util.ts` and `types.ts` can be
  imported. Nothing under test calls into it. **If a test needs one of those classes to behave,
  the function is not part of the format layer** and belongs behind a different seam — extract the
  pure half, the way `renumberMessageIds` was extracted from `recalculateMessageIds`.
- **Assert on exact text, not on "contains".** Round-trip stability is the property the write path
  depends on (`withMessageBlock` rewrites blocks in place), so the tests compare whole blocks byte
  for byte. A looser assertion would pass while the file quietly gained or lost a blank line on
  every edit.

## Source layout

| File | Contains |
| --- | --- |
| `main.ts` | The `Plugin` class: commands, events, the codeblock processor, config/style application, message writes |
| `ui.ts` | All DOM building — chat input, message bubble, action menu, inline editor, reply banners, author badges |
| `types.ts` | `Message` / `Header` (the file format), `ArchiveContext` (parsed file), `ChatNote` (per-file UI state) |
| `settings.ts` | `ChatConfig` + settings interface, defaults, the settings tab, YAML override parsing |
| `util.ts` | File-format parsing, header patching (`setHeaderField`), id arithmetic, timestamps, colour contrast, scrolling helpers |
| `reactions.ts` | The `reactions` header format and its add/remove operations (pure) |
| `emoji-picker.ts` / `emoji-data.ts` | The reaction picker popover and its bundled emoji set |
| `search.ts` | The search query, its `key:value` filters, which messages it matches, what the field suggests (pure) |
| `search-dates.ts` | Date values for the filters and reading a message's timestamp (pure) |
| `search-bar.ts` | The search bar: field, filter suggestions popover, match count, debounce, keymap scope |
| `filter-extension.ts` | CodeMirror field that collapses filtered-out messages in Live Preview |
| `sticky.ts` | Manual `position: sticky` for gutter elements (see quirks) |
| `modals.ts` | Delete-confirmation modal |
| `styles.css` | All styling; consumes the `--settings-*` custom properties set from `main.ts` |
| `tests/` | Vitest coverage of the file-format layer (see [Tests](#tests)) |

## How a chat note renders

1. `onload` registers the commands, the settings tab, a markdown codeblock processor for
   `chat-message`, and listeners on `active-leaf-change` (move the chat input),
   `workspace.resize` + `layout-change` (reposition it — `layout-change` is the only one that
   fires on a mode switch), `metadataCache.changed` (refresh the model, then the config), and
   `vault.rename` / `vault.delete` (drop the model).
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
  or classes on the *view container*, so the cascade reaches every message at once. **Config
  never gets painted onto individual rows**, even when it only applies to some of them: the
  pinned colour ships both values (`--settings-msg-pin-color` / `--settings-msg-pin-text-color`)
  and a `[data-pinned="true"]` rule in `styles.css` picks between them, exactly as the
  pinned-only filter and the reply outline do. A per-row sweep can only reach what is mounted,
  and Live Preview re-inserts the DOM it cached for an off-screen block without re-running the
  processor — so the sweep left the rest of the file on the old colour until a rerender, and the
  inline value it wrote shadowed the container for good.

  Embeds count as containers too. Canvas cards, embeds in other notes and hover popovers are
  not leaves of the file, so `getActiveContainers` misses them, and their rows fell back to the
  defaults in `styles.css`. Their `.markdown-embed` root (`embedHostOf`) gets the same styles:
  from `applyConfigToFile` for embeds with rows on screen, and from `styleEmbedHost` when a row
  is inserted into an embed that doesn't carry the current config yet. `saveSettings` includes
  files that are only rendered in an embed (`getRenderedChatPaths`).
- **`applyConfigToContext`** — the non-CSS values (`chatAuthor`, `defaultAuthorMode`) that
  the message-building code reads directly.

Only a YAML value that actually parses counts as an override; a typo or an empty key falls
through to the global setting rather than silently meaning `false`/`0`.

**`onYAMLChange` is a guard, not an event.** There is no frontmatter-only event: the API offers
`metadataCache.on("changed")`, which fires for every markdown file in the vault on every content
change, message edits included (`vault.on("modify")` is strictly worse — same frequency, no
parsed frontmatter). So the handler's first job is establishing that the *YAML* changed;
everything past that point is the response to a config or chat-status change and must not run
for a message edit. The comparison is by value, since each parse yields a fresh object, and
against `yamlCache` — seeded in **`updateFileConfig`** next to the config it resolved, so it
reads as "does the YAML still match the one the cached config was built from". Seeding it only
inside `onYAMLChange` left it `undefined` until the first change, so the first save of a session
re-applied the whole config. Two edges it has to get right: a file that *lost* its frontmatter
still has to pass (that is how a chat note ends — only missing on both sides stops), and an
unrecorded `isChatNote` counts as `false`, since `false !== undefined` read "still not a chat
note" as a status change and rebuilt the view of any ordinary note whose properties were edited.

**A container is per *view*, not per file, so config is applied at the switch.** `applyStyles`
writes to the view container, which a tab reuses when it navigates to another file — it arrives
still carrying the previous file's `--settings-msg-*` values, and nothing about rendering clears
them. `onFileSwitch` therefore applies the config itself. Leaving that to the first message to
render was wrong twice over: the render-time gate (`lastAppliedConfig !== configCache`) is an
identity check on the *file's* config, so returning to a file whose config hadn't changed since
it was last applied skipped it, and a back/forward that re-inserts an already rendered view runs
no processor at all. Either way the container kept the other file's colours.

The gate stays as the fallback for a container that mounts without a switch. Two things it
implies: a resolved config must not be memoized into a stable object (the identity *is* the
signal), and anything that calls `updateFileConfig` and then applies the config itself should set
`lastAppliedConfig`, or the next render repeats the work.

## Quirks and tricks

**Two view modes.** Reading View has a flat DOM; Live Preview mounts each
message as a CodeMirror block widget inside nested flex containers. Nearly every awkward
piece of this codebase exists because something has to behave the same in both.

**And more than one window.** A popout window is a separate `window` with its own `document`,
so the module-level `window` / `document` globals mean *the main window*, not "the one this
element is in". Obsidian gives every node its own pointers, `el.win` and `el.doc` (and, where
there is no node to ask, the `activeWindow` / `activeDocument` globals), and everything here that
observes, listens or measures goes through them: `setupResizeObserver` builds its
`ResizeObserver` from `el.win` (an observer
only delivers callbacks from the rendering lifecycle of the window it was constructed in, so a
main-window one never fires for a resized popout), `sticky.ts` builds its `IntersectionObserver`
from the scroller's window for the same reason, `sticky.ts` and `attachStickyReplyIcon` bind
their resize listeners to the scroller's window, and `waitUntilVisible` measures against
`element.win.innerHeight`. Both keep the window they registered with rather than reading it back
at teardown — a *detached* node reports the global window, which would remove the listener from
the wrong one.

`requestAnimationFrame` is per window as well, and the main window's frames are throttled or
stop while a popout has focus. So every frame loop runs on the window of the element it works
on — the sticky updates, the scroll-on-send loop, and the polls in `waitForMessageRow` /
`waitUntilVisible` (with the main window's frames, the reply flash never played). Frame ids are
per window too, so a pending frame is cancelled through the window that scheduled it
(`cancelResizeFrame` and `cancelScrollHold` hold a closure, not an id).

One thing is known **not** to be a problem, verified by hand: building DOM with the main
document's `createElement` is fine, since `appendChild` adopts a node across documents.

**Dragging a tab into another window fires no file event.** "Open in new window" opens the file
in a *new leaf*, so `file-open` → `handleFileSwitch` → `onFileSwitch` rebuilds everything for the
new window. Dragging a tab out instead **moves the existing leaf**: the file never changes, so
`file-open` doesn't fire, and the leaf object doesn't change either. `layout-change` does fire,
but it only repositions — it does not re-run the switch, so the resize observer stayed bound to
the window the view had just left, and a dragged-out tab lagged where "Open in new window" was
fine. `setupResizeObserver` therefore registers `el.onWindowMigrated`, Obsidian's own signal for
the move, which fires *after* the node is in its new window (when `el.win` is finally right) and
returns a destroy function the next registration calls.

**A rerender is not a file switch.** `refreshFile` rebuilds the view two different ways: reading
mode gets `previewMode.rerender(true)`, the editor gets `leaf.rebuildView()`. Only the second
reloads the view and so provokes `file-open` — and `onFileSwitch` is what mounts the chat input,
hides it, and installs the ResizeObserver. Relying on that event meant a note that *became* a
chat note while in reading view never got an input (and one that stopped being a chat note kept
it), while the same edit in the editor worked instantly. `refreshFile` therefore calls
`handleFileSwitch` itself; every step of it is idempotent, so the editor branch running it twice
costs nothing.

**`position: sticky` doesn't work** — it's fine in Reading View and inert in Live Preview.
`sticky.ts` reimplements it by tracking scroll: one shared listener + `IntersectionObserver`
per scroller, recomputing only rows currently on screen. The author badge uses that shared
registry; the reply icon (`attachStickyReplyIcon` in `ui.ts`) keeps its own listeners, since
it is only visible while its row is hovered, so at most one row is ever tracked.

A row joins the registry when it is **inserted into the page** (`onNodeInserted`), not after a
fixed delay: Reading View runs the codeblock processor for sections ahead of the viewport and
inserts them only as they scroll near, so a message further down can sit detached for as long
as the reader takes to get there. A single-frame wait would register only the rows near the view.

Positions are only recomputed on scroll and resize, and a hidden element (badges switched off)
is skipped, so it keeps its last offset. Anything that moves the elements without scrolling has
to call `refreshSticky()`. `applyConfigToFile` does, which is what places the badges correctly the
moment they are switched back on, and after a corner radius change.

**Off-screen messages have no row.** Both view modes only render near the viewport, so a
message far away has no node at all. `scrollToMessage` therefore jumps to its *source line*
first (`setEphemeralState`), which mounts it via the codeblock processor, then polls
`waitForMessageRow` before scrolling precisely.

**A row can be in the DOM and not on the page.** Both subviews stay mounted, so once Live
Preview has rendered, its rows are still in the document while you read — `isConnected` is
true for every one of them. Picking one of those to scroll to is a silent no-op: the node has
no layout, `scrollIntoView` does nothing, the flash plays where nobody can see it, and
`waitUntilVisible` burns its full timeout on a 0×0 rect. That was the reply banner doing
nothing in Reading View, but only in a tab that had been in Live Preview at some point.

So anything that resolves "the row for this message" filters with `isRowRendered` (a null
`offsetParent`, which is also how the pin filter's animation skips hidden rows), and anything
answering a *click* resolves it in `rowScroller(origin)` — the scroller the click came from —
so a note open in two panes scrolls the pane the reader is actually looking at.

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
editor branch captures `getScrollInfo()` and holds it with `holdScroll` for 500 ms: the
processor renders the new widget asynchronously, so its height keeps changing for several frames,
and a single restore can land before the jump. The hold alone still showed a one-frame flash,
since the new widget starts out empty and everything below it moves up before the correction
runs, so `reserveBlock` also keeps the old height on the new block (`min-height` via
`.chat-block-reserved`) until the processor has rendered it. It carries the old row's hover
too (`is-hover-carried`): the new row isn't `:hover` until the pointer moves, which briefly
swapped the author badge back over the reply button. Reading View never sees this
because it has no editor and takes the `vault.process` branch.

**An unknown message id is not an error.** `source` *is* the block, so a message the model
hasn't seen — typed by hand, pasted, or appended a moment ago — is parsed straight from it.
Live Preview re-runs the processor on every keystroke while a block is being typed, so
throwing (or rebuilding the model) there fired once per character.

**Blank lines are content.** `parseMessages` walks the file line by line and must skip only
the index guard, never an empty line: blank lines carry the body's markdown paragraph
structure. Dropping them is not cosmetic — the processor prefers the *parsed* body over the
block's own source, so every multi-paragraph message rendered as one paragraph, and the
inline editor is seeded from that same body and saves it back, so an edit wrote the collapsed
version to disk.

**Scroll-on-send can't wait for the render.** The write only *schedules* the processor, and
waiting for the new message to render deadlocks, since it renders *because* something scrolled
to it. So `scrollToBottomAfterSend` scrolls immediately and keeps re-scrolling through
`holdScroll` for 500 ms, dragging the render along.

**The next id is allocated inside the write.** `appendMessage` wraps the whole read-modify-
write in `vault.process` and derives the id from *that* text, not from the cached model —
two sends inside the metadata debounce would otherwise both see the same highest id and
collide.

**Row vs bubble — the row is the identity.** `.chat-message-row` wraps the bubble
(`.chat-message`) along with the reply button and the author badge. The row is what carries
the data attributes (`data-msg-id`, `data-chat-src`, `data-pinned`, `data-reply-target`), what per-message CSS
variables are set on, and what state is expressed against — the CSS then reaches down to the
bubble where a bubble-shaped effect is wanted. Variables have to live on the row because the
badge and its tail are *siblings* of the bubble and would never inherit from it; the tail has
to be a sibling because the bubble's own `overflow: hidden` (which clips the reply banner to
its rounded silhouette) would cut it off.

`chat-message-scroll-flash` is the one remaining state *class* on the row, and it can be:
it is transient (900 ms), so nothing has to survive an unmount. Everything durable is a data
attribute, for the reason given under "Live Preview re-inserts cached rows" below.

**Borders are `box-shadow`.** `overflow: hidden` clips an element's children but never its
own border, so a real border would show through as a ring behind the flush reply banner.
Same trick on the bubble and the input container.

**Settings apply without a rerender.** Author/timestamp visibility and the author badges are
always *built*, and only shown or hidden by a class on the container. That is what lets a
settings or YAML change take effect on messages already on screen.

That is also why `saveSettings` must never rebuild a view. Colour pickers and sliders fire
`onChange` on every drag tick, so it does the cheapest thing that still shows the change:
`updateFileConfig` + `applyConfigToFile` for the **open** chat files only. Files that aren't
open need nothing — `handleFileSwitch` resolves a file's config when it is opened.

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

**When the state changes at runtime, the flag has to be re-synced, not just set.** The reply
target is the case the pattern above can't fully cover: "which row is the target" changes
while rows are unmounted, and CSS cannot compare a container's attribute against a row's. So
the row carries `data-reply-target` like any other flag, and it is kept current three ways:
- set at render (`syncRowReplyTarget`);
- on a target change, re-set on every mounted row *and* on every row flagged so far
  (`markReplyTarget`). The plugin remembers the flagged rows (`replyTargetRows`, one target's
  worth per file) because a flagged row cached off screen is out of reach of any DOM query, and
  clearing the flag has to reach it;
- re-checked by the row itself whenever it enters the viewport, which covers the opposite case,
  a cached row that should *gain* the flag. It rides on the IntersectionObserver `sticky.ts`
  already runs on every row (`registerSticky`'s `onVisible`), so it costs no extra observer.

The look stays in `styles.css`: the attribute rule only raises `--msg-reply-outline` /
`--msg-reply-btn-opacity` / `--msg-reply-btn-events`.

Don't reach for a runtime `<style>` element instead: `obsidianmd/no-forbidden-elements` forbids
it, and the community directory's review rejects disabling that rule.

**Replies resolve forward-only, at render.** A reply stores its target's id; the target stores
nothing. Nothing indexes replies and deleting a message carries no bookkeeping — each banner
resolves its own target through the `messageMap` lookup it already does, against a model
`withMessageBlock` refreshed before the write. A target that doesn't resolve renders as an
inert "Message not found" banner rather than as no banner: `reply_to` is still in the file, so
dropping it silently loses the relationship. Being a render-time decision, it is also correct
for a Live Preview cached re-insert. The Notice from `scrollToMessage` covers exactly the gap
that leaves: a row rendered *before* the delete still carries a live-looking banner, and
clicking it has to say why nothing happened.

**Reactions sit outside the bubble.** The bubble's `overflow: hidden` would clip anything
overlapping its edge, so the reaction bar is a sibling of the bubble inside the row, pulled up
by a negative margin to straddle the bottom edge. The row carries `data-has-reactions`, which
makes room for the bar in CSS and is the hook for a future "has reactions" filter, built the
same way as the pinned-only one. A filter for one specific emoji can't be pure CSS (a container
can't pass a value to a row-level selector, and runtime `<style>` is forbidden), so it would
follow the reply-target pattern: a per-row flag set at render and re-synced on `onVisible`.

**The search filter is a row flag synced from a registry of every rendered row.** It hides rows
the way the pinned-only filter does — `.msg-search-active` on the container, `data-search-match`
on the row — but whether a row matches changes with every query, so a query change has to reach
rows that are not in the document: Live Preview's widget cache and Reading View's off-screen
sections both keep rendered rows *detached*, and put them back carrying whatever flag they had.
The reply-target answer (re-check on `onVisible`) came a frame late here: the row showed, then
vanished, and Reading View had already measured it at full height by then. So the plugin keeps
`chatRows`, every row it has rendered with the message it was rendered from, and `syncSearchRows`
re-flags all of them synchronously. An entry goes when its block's render child unloads, so the
map holds what the views hold and no more. Clearing the search only removes the container class.

**Hiding a row doesn't give its space back by itself.** Both view modes lay out what is off
screen from stored or estimated heights, not from the DOM.

- *Live Preview:* CodeMirror reserves an *estimated* height for lines it hasn't rendered, so a
  filtered row shrank to zero only once it had rendered. Two matches far apart came out with a
  large blank gap between them, and the later one sat below it until scrolling had rendered and
  collapsed everything in between (after that CodeMirror remembers the measured heights, which
  makes it hard to reproduce). `filter-extension.ts` fixes this for both filters. A `StateField`
  of replacing block decorations at the highest precedence collapses each run of hidden messages
  to a zero-height widget, so those lines are never rendered or estimated. It recomputes on a
  refresh effect, which the plugin dispatches when a filter changes or the model is rebuilt, and
  on a mode switch. A plain document change only maps it, so typing doesn't reparse the file. The
  range maths (`hiddenLineRanges`, which also swallows the blank lines between hidden blocks) is
  pure and tested.
- *Reading View:* the renderer measures every section once and lays out the detached ones by
  those heights. After a filter change they were stale: hidden messages kept their old height as
  empty scroll space, and a later match only appeared once scrolled to where it *used to* be.
  `remeasureReadingViews` resets the measurements and queues a render, which is what the
  renderer does itself after a width change. It re-measures without re-running the codeblock
  processors. That is **private API** (`previewMode.renderer`, `sections[].resetCompute`,
  `queueRender`), probed like `rebuildView`; if a future Obsidian drops it, the filter still
  works and only the stale space comes back. It runs after `syncSearchRows`, because the
  renderer measures the rows as soon as it re-attaches them. The author badge setting is the
  one other thing that changes a message's height without a rerender (the wider gutter
  re-wraps every bubble), so `applyConfigToFile` re-measures when that value changes. Anything
  new that alters row height through a container class or variable needs the same.

`search.ts` holds what a query *is* and what it matches, and nothing else knows. A query is
Discord-style `key:value` filters plus whatever free text is left: `SEARCH_FILTERS` lists the
names (the first is the one suggested, the rest are aliases), `parseSearchQuery` takes them out
of the text into fields on `SearchQuery`, and `messageMatches` ANDs them. A new filter is an entry
there, a field, a `case` in each, and its values in `searchSuggestions`. Three decisions in it
that are easy to undo by accident:

- **A name that isn't a filter stays text**, so `https://…` and `14:33` still search as typed.
- **A filter with no value yet is no condition**, and a query of only those is `null`, so typing
  `author:` doesn't hide the whole note for a moment before the name arrives.
- **Dates resolve to a span**, not an instant (`parseDateValue`: a day, a month, a year, a
  minute), which is what lets `before:`/`after:` leave out the period they name, as Discord's do,
  and lets `time:` match a day whatever zero-padding the timestamp has. Relative values (`7d`)
  are resolved against `now` *at parse time*; the query is re-parsed whenever the text changes,
  so a search left open for hours keeps its original cut-off. `now` is a parameter for the tests.

The suggestions are an `AbstractInputSuggest` over the field. `searchSuggestions` is the pure
half: filter names for the word at the caret, then that filter's values. It offers nothing on a
blank word unless the whole field is blank — the popover's scope takes `Enter`, so suggesting
after `deploy␣` would turn Enter into a pick instead of a search. Selection uses `onSelect`
(1.4.10), not an overridden `selectSuggestion` (public only from 1.6.6), and re-fires `input` in a
microtask so the value suggestions open after the popover has closed itself. The bar is one element moved between views like the chat input, but it tracks
its own `searchFile` rather than `currentFile`, since a background pane's search button opens it
there. Its debounce is flushed when the bar moves to another file, so text typed for one note
never lands on the next.

The emoji picker is attached to the anchor's own `doc.body` with `position: fixed`, for the same
clipping reason and so it works in popout windows. Only one is open at a time; it closes with
its action menu (`closeMenu`), on a pick, Escape, an outside press, a scroll or a resize. The
search bar's emoji button opens the same picker (`toggleSearchEmojiPicker`) and types the pick at
the field's caret; it is closed when the bar moves to another file, so a late pick can't land there.

**Emoji have names.** `emoji-data.ts` pairs every listed emoji with its Discord name, which is what
a Discord export stores (`:fire:`) and what people type. `emojiName` / `emojiByName` map between
the two, ignoring the variation selector. Reactions stay stored however they were added; the
mapping is read-side only, so `reaction:` finds 🔥 and `:fire:` either way (`reactionTerms` in
`search.ts`) and the picker's field filters the grid by name. An exact name means that one emoji,
so `reaction:heart` doesn't also find 😍; a partial one matches any name containing it.

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
hidden for non-chat files. Its text is cached per file on the `ChatNote`. It reads
`plugin.currentFile` — the file it is mounted for — and never `getActiveFile()`, which points
elsewhere when focus sits in a sidebar or a second markdown leaf.

**Nothing the plugin puts on a view is reclaimed for it.** `syncChatViews()` is the one sweep
that keeps this honest: it toggles `chat-note-view` on each view's `contentEl` and drops the
`addAction` buttons from views that are no longer showing a chat note. `onunload` clears both
for every open view, and pops the input's keymap `Scope` — a `Scope` left pushed keeps
swallowing `Mod+Enter` for the rest of the session, and the blur handler can't be relied on to
pop it, because removing a *focused* element from the DOM fires no blur.

Pending timers are the same problem in time rather than space, so anything that reaches back
into the plugin is scheduled through `later()` and cancelled in `onunload` — `scheduleRefresh`
being the one that matters, since its rerender ends in `handleFileSwitch` and would remount the
chat input, keymap scopes and all, against a plugin that is gone. The `requestAnimationFrame`
loops (`holdScroll`, the resize coalescing) keep their handles for the same reason.
Timers that only touch their own element — the copy button's icon reset, the header row's
`focusout` tick, both in `ui.ts` — are deliberately left alone: that element is detached by the
time they fire.

**Styling that reaches Obsidian's own note elements lives under `.chat-note-view`.** Note
background, the bottom padding that clears the chat input, embed spacing — unscoped, these
apply to every note in the vault, in every vault that merely has the plugin installed. Rules
that only touch the plugin's own classes need no such scope.

**CSS variables are prefixed `--chat-input-*`, not `--input-*`** — Obsidian's own theme
defines `--input-radius` / `--input-border-width` globally, and reusing those names reskins
all of Obsidian's UI.

**Hotkeys go through `Scope`.** Obsidian's global keymap can swallow `Mod+Enter` before a
plain `keydown` listener sees it, so the input pushes its own `Scope` while focused. That is
also what lets `Mod+Up` mean "open the header row" here while whatever the user has bound it
to globally still works everywhere else. The commands themselves ship **no default hotkeys**,
per Obsidian's guidelines — don't add any back.

**The renumber scans blocks, it does not use the message map.** The transform itself is
`renumberMessageIds` in `util.ts` — pure, and the one function in the plugin that rewrites a whole
user file at once, which is why it is separated from the Obsidian I/O around it and covered by
tests. `recalculateMessageIds` in `main.ts` is what remains: read the text from the editor or the
vault, hand it over, write the result back. It is the repair path for a file whose ids were broken
by hand, and the commonest break is a duplicate —
which `parseMessages` cannot represent, since its map keeps one entry per id and the other block
vanishes. So it uses `findMessageBlocks`, which returns every block in file order, duplicates
included. The two read the id differently for the same reason: `extractMessageIdFromSource`
takes it off the block's *first line* (fine for blocks this plugin wrote, since `Header.toString`
emits `id` first), while `findMessageBlocks` searches the whole header, because
`Header.fromLines` accepts the keys in any order and a hand-edited block may well not lead with
`id`. Whatever predicate finds the id line must match the one that rewrites it — if one accepts
an indented key and the other doesn't, that block keeps its old id and collides with the new
numbering.

Headers are patched line by line rather than re-serialised, as `setHeaderField` does for the
pin and reactions:
round-tripping through `Message.toString()` would reorder the header keys and renormalise the
body, a large, surprising diff for a change to one line. The write replaces from the first block to the end of the document: dropping a
`reply_to` changes the line count, so the blocks' own `endLine` no longer describes the patched
text. The duplicate notice fires from `createArchiveContext` only — `invalidateArchiveContext`
runs on every save, and a block being typed passes through states where its id repeats another.

**Writes go through the editor when there is one, never `setValue`.** `withMessageBlock`
prefers `editor.replaceRange` on the *target file's* view — it preserves undo history and the
caret, and rewriting the whole document (`setValue`) would also rewrite the frontmatter, which
fires the metadata listener and forces a full rerender. Resolve the view by
`view.file?.path === file.path`, never `getActiveViewOfType`: the delete and edit handlers
used to grab the *focused* editor, so acting on a message in a background leaf could write one
file's content into another's.

**The 300 ms delay in `onYAMLChange`** (`scheduleRefresh`, before a full rerender) is there to
avoid an error in the embed-link plugin; it isn't arbitrary.

**`author` is the one override that rerenders.** Everything else in the config reaches the page
through `applyConfigToFile`, but the chat owner is a *comparison*: `is-owner` (which gutter a
message's author badge sits in) is decided per message against it and stamped on the row at
render. A sweep can only re-toggle that on mounted rows, and Live Preview re-inserts the DOM it
cached for an off-screen block without re-running the processor, so the rest of the file kept the
old gutter. It can't move to the container the way the two bubble colours did — CSS cannot
compare a row to a file-level name — so `onYAMLChange` compares the *resolved* owner across
`updateFileConfig` and calls `scheduleRefresh` when it moved. Affordable because the owner is
normally set once per note; do not reach for this for anything that changes more often.

## Adding a setting

1. `settings.ts`: add the key to `ChatConfig` (only if it should be YAML-overridable), to
   `ChatNotesPluginSettings`, and to `DEFAULT_SETTINGS`.
2. Add its entry to `ChatNotesSettingTab.getSettingDefinitions()`. Obsidian 1.13+ renders that
   list itself; `display()` renders it on older versions, so a new control type needs a case
   there and in `SettingSpec`.
3. If overridable: map a YAML alias in `getFileOverrides`, through `parseBooleanOverride` /
   `parsePixelOverride` so a bad value falls back instead of breaking.
4. Consume it — visual settings in `applyStyles` (a CSS variable or a container class),
   plain values in `applyConfigToContext`.
5. Document it in the README's override table, and add its YAML alias to `OVERRIDE_KEYS` in
   `settings.ts`, which is what the **Add override properties** command writes.

`saveSettings` already re-resolves every file's config and refreshes open files, so nothing
else has to be wired up.

