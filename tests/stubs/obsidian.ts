/* The `obsidian` npm package is types only ("main": "" in its package.json), so a runtime
   `import { MarkdownView } from "obsidian"` has nothing to resolve to outside the app. Vitest
   aliases the module to this file (see vitest.config.ts).

   These are NOT mocks: nothing under test calls into them. util.ts and types.ts import a
   handful of Obsidian classes for `instanceof` checks and type annotations in code paths the
   format tests never reach, and this exists only so those modules can be imported at all. If
   a test ever needs one of these to behave, that is the signal the function under test is not
   part of the pure format layer and does not belong in these tests. */

export class MarkdownView {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Notice {}
export class App {}
export class TFile {}
export class TAbstractFile {}
export class TFolder {}
export class Scope {}
