# Chat Notes Plugin

What does this plugin add?
- This plugin adds chat notes to Obsidian. A chat note has an input field to write new messages and a system to render and display the messages. All other notes will still work just like normal.

Why use this plugin?
- This plugin was originally designed to export private Discord servers into Obsidian, however, it can be used independently. If you like a message-based note system, where it's easy to separate and see the timestamps of your ideas in the same file, then this plugin might be for you.

# Installation

# Usage

## Creating a chat note

Run the **Create new chat note** command, or click the ribbon icon.

To turn an existing note into a chat note, add this to its frontmatter (section at the very top of the file):

```yaml
---
type: chat
---
```

`type: chat` is what the plugin looks for. Without it a note renders normally, and every
message block in it stays a plain code block.

## Shortcuts

These work while the chat input has focus. `Mod` is `Ctrl` on Windows/Linux, `Cmd` on macOS.

| Shortcut | Where | Action |
| --- | --- | --- |
| `Mod` + `Enter` | Message input | Send the message |
| `Mod` + `↑` | Message input | Open the author/time row |
| `Mod` + `↑` | Author or time field | Close the row, back to the input |
| `Esc` | Author or time field | Close the row, back to the input |

## Commands

Every command except **Create new chat note** is only available inside a chat note.
Default hotkeys can be changed under **Settings → Hotkeys**.

| Command | Default hotkey |
| --- | --- |
| Create new chat note | — |
| Focus chat input | `Mod` + `M` |
| Scroll to Bottom | `Mod` + `↓` |
| Scroll to Top | `Mod` + `↑` |

> `Mod` + `↑` scrolls to the top everywhere *except* while the chat input or a header field
> has focus, where it opens or closes the author/time row instead.

## Overriding global settings per chat note

Global settings live under **Settings → Community plugins → Chat Notes**.
Here many features like various colors, corner radius, visible attributes in the  message header, input width and height, default author, ribbon icon visibility and more can be adjusted. By default these apply to *all* chat notes. If you want different settings for different chats, you can override most of the settings per file by adding the matching key to that note's frontmatter:

```yaml
# Example
---
type: chat
author: Alice
msgColor: "#7f6df2"
msgCornerRadius: 20
msgAuthorBadges: true
---
```

A few things to know:

- Overrides apply **only** to that note. Everything that is not listed keeps its global value.
- Most changes should apply live, without reopening the note.
- A typo or an empty key is ignored and will still use its global setting value.
- Colors accept any CSS color: `#2b5d8a`, `#abc`, `white`, `rgb(43 93 138)`.
    - If you **paste** the frontmatter directly into the file or **manually write** it (i.e. its a blank file or has no properties yet added) use quotes for values starting with `#`, or YAML reads them as a comment. Also make sure that the first `---` is at the very top of the file (no empty line above), or Obsidian will not recognize the values as properties. If done correctly, Obsidian should format the frontmatter into a properties table. There are other ways to add properties to a file (there is a command for it aswell), refer to Obsidians info page about [Properties](https://obsidian.md/help/properties).
    - If you input a value starting with `#` via the properties table (once Obsidian has recognized the keys) you should **not** use quotes, just put the value as is.

### Available overrides

| Key | Value | Overrides setting |
| --- | --- | --- |
| `author` | text | *(YAML only)* The chat owner - who counts as "you" |
| `msgColor` | color | Message background color |
| `msgPinColor` | color | Message highlight color |
| `msgFlashColor` | color | Message flash color |
| `msgReplyColor` | color | Reply banner color |
| `msgBorderColor` | color | Message border color |
| `msgCornerRadius` | number, `0`–`50` | Message corner radius |
| `msgShowAuthor` | `true` / `false` | Show message author |
| `msgShowTime` | `true` / `false` | Show message time |
| `msgAuthorBadges` | `true` / `false` | Show author badges |
| `msgButtonShadow` | `true` / `false` | Enable button shadow |
| `msgScrollOnSend` | `true` / `false` | Scroll to bottom on send |
| `msgDefaultAuthor` | `owner` / `previous` | Default message author |
| `chatId` | text | *(reserved - read but not currently used)* |

Out-of-range numbers are clamped rather than ignored: `msgCornerRadius: 999` gives 50.

### Global-only settings

These have no per-note override and always apply everywhere:

- Show ribbon icon
- Input field width offset
- Max input field height

## Compatibility


# Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture, the message file format, and the
non-obvious bits of the implementation.

