import { App, PluginSettingTab, Setting, TFile } from "obsidian";
import ChatNotesPlugin from "./main";

// which author an empty author field falls back to: the chat owner (YAML `author`) or
// whoever sent the previous message
export type DefaultAuthorMode = "owner" | "previous";


export interface ChatConfig {
	// holds all possible settings for a chat to override global settings
	// (can contain more than global settings)

	defaultAuthorMode?: DefaultAuthorMode;
	messageBgColor?: string;
	enableButtonShadow?: boolean;
	showMessageAuthor?: boolean;
	showMessageTimestamp?: boolean;
	showAuthorBadges?: boolean;
	scrollOnSend?: boolean;
	messageCornerRadius?: number;
	author?: string;
	messagePinColor?: string;
	messageFlashColor?: string;
	messageReplyColor?: string;
	messageBorderColor?: string;
	contrastHeadings?: boolean;
	// add future settings (that can be overriden in yaml) here
}


export interface ChatNotesPluginSettings extends ChatConfig {
	messageBgColor: string;
	enableButtonShadow: boolean;
	showMessageAuthor: boolean;
	showMessageTimestamp: boolean;
	showAuthorBadges: boolean;
	scrollOnSend: boolean;
	messageCornerRadius: number;
	messagePinColor: string;
	messageFlashColor: string;
	messageReplyColor: string;
	messageBorderColor: string;
	contrastHeadings: boolean;
	inputMaxHeight: number;
	inputWidthOffset: number;
	defaultAuthorMode: DefaultAuthorMode;
	showRibbonIcon: boolean;
	// specify the variables that should appear in global settings
}

// shared by the settings slider and the YAML override parser, so the two can't drift apart
export const CORNER_RADIUS_MIN = 0;
export const CORNER_RADIUS_MAX = 50;

// the colours and the corner radius are mirrored as the var() fallbacks in styles.css
export const DEFAULT_SETTINGS: ChatNotesPluginSettings = {
	messageBgColor: "#6d54b1",
	enableButtonShadow: true,
	showMessageAuthor: true,
	showMessageTimestamp: true,
	showAuthorBadges: false,
	scrollOnSend: false,
	messageCornerRadius: 12,
	messagePinColor: "#ec4e52",
	messageFlashColor: "#eff2f3",
	messageReplyColor: "#e1e1ec",
	messageBorderColor: "#444444",
	contrastHeadings: false,
	inputMaxHeight: 200,
	inputWidthOffset: 0,
	defaultAuthorMode: "owner",
	showRibbonIcon: true,
	// add default values here
};


type SettingKey = keyof ChatNotesPluginSettings;

// the subset of Obsidian's SettingDefinitionControl used here; declared locally because
// those types are 1.13+ and the display() fallback reads these objects on older versions
interface SettingSpec {
	name: string;
	desc: string;
	control:
		| { type: "color"; key: SettingKey }
		| { type: "toggle"; key: SettingKey }
		| { type: "slider"; key: SettingKey; min: number; max: number; step: number }
		| { type: "dropdown"; key: SettingKey; options: Record<string, string> };
}

export class ChatNotesSettingTab extends PluginSettingTab {
	plugin: ChatNotesPlugin;

	constructor(app: App, plugin: ChatNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// rendered by Obsidian 1.13+ (and indexed for settings search); display() renders the
	// same list on older versions
	getSettingDefinitions(): SettingSpec[] {
		return [
			{
				name: "Message background color",
				desc: "Determines the background color of message bubbles",
				control: { type: "color", key: "messageBgColor" },
			},
			{
				name: "Message pin color",
				desc: "Determines the background color of a pinned message",
				control: { type: "color", key: "messagePinColor" },
			},
			{
				name: "Message flash color",
				desc: "Determines the color of the short flash played when scrolling to a specific message",
				control: { type: "color", key: "messageFlashColor" },
			},
			{
				name: "Reply banner color",
				desc: "Determines the background color of the 'reply to' banner shown on messages that reply to another one",
				control: { type: "color", key: "messageReplyColor" },
			},
			{
				name: "Message border color",
				desc: "Determines the outline color of message bubbles and the chat input field",
				control: { type: "color", key: "messageBorderColor" },
			},
			{
				name: "Enable button shadow",
				desc: "Toggle shadow on message action buttons; override per file with 'msgButtonShadow: true' or 'msgButtonShadow: false'.",
				control: { type: "toggle", key: "enableButtonShadow" },
			},
			{
				name: "Show message author",
				desc: "Show the author name in the header of every message; override per file with 'msgShowAuthor: true' or 'msgShowAuthor: false'.",
				control: { type: "toggle", key: "showMessageAuthor" },
			},
			{
				name: "Show message time",
				desc: "Show the timestamp in the header of every message; override per file with 'msgShowTime: true' or 'msgShowTime: false'.",
				control: { type: "toggle", key: "showMessageTimestamp" },
			},
			{
				name: "Show author badges",
				desc: "Give each message a speech-bubble tail with the author's avatar and name beside it, in the gutter - on the right for the chat owner (the file's 'author' YAML key) and on the left for everyone else; widens the gutter slightly while on; override per file with 'msgAuthorBadges: true' or 'msgAuthorBadges: false'.",
				control: { type: "toggle", key: "showAuthorBadges" },
			},
			{
				name: "Match headings to message text",
				desc: "Color headings inside messages like the message text, so they stay readable on any bubble color. Off keeps your theme's heading colors; override per file with 'msgContrastHeadings: true' or 'msgContrastHeadings: false'.",
				control: { type: "toggle", key: "contrastHeadings" },
			},
			{
				name: "Message corner radius",
				desc: "Determines how round corners of the message bubbles are; override per file with 'msgCornerRadius: 20'.",
				control: { type: "slider", key: "messageCornerRadius", min: CORNER_RADIUS_MIN, max: CORNER_RADIUS_MAX, step: 1 },
			},
			{
				name: "Default message author",
				desc: "Which author a new message is sent as when its author field is left empty; override per file with 'msgDefaultAuthor: owner' or 'msgDefaultAuthor: previous'; the chat owner itself is the file's 'author' YAML key.",
				control: {
					type: "dropdown",
					key: "defaultAuthorMode",
					options: { owner: "Chat owner", previous: "Previous message's author" },
				},
			},
			{
				name: "Scroll to bottom on send",
				desc: "Jump to the end of the chat every time a message is sent; override per file with 'msgScrollOnSend: true' or 'msgScrollOnSend: false'.",
				control: { type: "toggle", key: "scrollOnSend" },
			},
			{
				name: "Show ribbon icon",
				desc: "Show a button in the left ribbon for creating a new chat note; the command itself stays available from the command palette either way, and can be given a hotkey there.",
				control: { type: "toggle", key: "showRibbonIcon" },
			},
			{
				name: "Input field width offset",
				desc: "Widens or narrows the message input field relative to the message bubbles it sits under. At 0 its edges line up with the messages.",
				control: { type: "slider", key: "inputWidthOffset", min: -150, max: 150, step: 5 },
			},
			{
				name: "Max input field height",
				desc: "Determines how tall the message input field can grow before it starts scrolling",
				control: { type: "slider", key: "inputMaxHeight", min: 60, max: 600, step: 20 },
			},
		];
	}

	// the base versions only exist from 1.13 on, and saveSettings also updates open chat notes
	getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, { [key]: value });
		await this.plugin.saveSettings();
	}

	// fallback for Obsidian before 1.13
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const { name, desc, control } of this.getSettingDefinitions()) {
			const setting = new Setting(containerEl).setName(name).setDesc(desc);
			const value = this.getControlValue(control.key);
			const save = (newValue: unknown) => this.setControlValue(control.key, newValue);

			switch (control.type) {
				case "color":
					setting.addColorPicker(color => color.setValue(value as string).onChange(save));
					break;
				case "toggle":
					setting.addToggle(toggle => toggle.setValue(value as boolean).onChange(save));
					break;
				case "slider":
					setting.addSlider(slider => slider
						.setLimits(control.min, control.max, control.step)
						.setValue(value as number)
						.onChange(save));
					break;
				case "dropdown":
					setting.addDropdown(dropdown => dropdown
						.addOptions(control.options)
						.setValue(value as string)
						.onChange(save));
					break;
			}
		}
	}
}


// only a value that reads as a boolean counts as an override; anything else resolves to
// undefined, so resolveConfig drops it and the global setting stands
function parseBooleanOverride(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

// same for numbers, except out-of-bounds values are clamped rather than dropped
function parsePixelOverride(value: unknown, min: number, max: number): number | undefined {
	// Number("") is 0, so an empty string has to be rejected before the conversion
	const parsed =
		typeof value === "string"
			? (value.trim() === "" ? undefined : Number(value.trim()))
			: value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
	return Math.min(Math.max(parsed, min), max);
}

/* and for text. Frontmatter values are `any`, so this is also what keeps a YAML number or
   list from reaching a field typed as a colour or a name. An empty string resolves to
   undefined rather than to "", so it falls through to the global setting instead of blanking
   it. */
function parseStringOverride(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

// every alias getFileOverrides reads, in the order the "Add override properties" command
// writes them. Kept next to that function so the two can't drift apart.
export const OVERRIDE_KEYS = [
	"author",
	"msgColor",
	"msgPinColor",
	"msgFlashColor",
	"msgReplyColor",
	"msgBorderColor",
	"msgCornerRadius",
	"msgShowAuthor",
	"msgShowTime",
	"msgAuthorBadges",
	"msgContrastHeadings",
	"msgButtonShadow",
	"msgScrollOnSend",
	"msgDefaultAuthor"
];

export function getFileOverrides(app: App, file: TFile): ChatConfig {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;

	if (!fm) return {};

	// only a recognised mode counts as an override; a typo falls through to the global one
	const authorMode = parseStringOverride(fm.msgDefaultAuthor);
	const defaultAuthorMode: DefaultAuthorMode | undefined =
		authorMode === "owner" || authorMode === "previous"
			? authorMode
			: undefined;

	// set variable alias names for the yaml overrides here:
	return {
		author: parseStringOverride(fm.author),		// the chat owner - yaml only, never a global setting
		defaultAuthorMode,
		messageBgColor: parseStringOverride(fm.msgColor),
		messagePinColor: parseStringOverride(fm.msgPinColor),
		messageFlashColor: parseStringOverride(fm.msgFlashColor),
		messageReplyColor: parseStringOverride(fm.msgReplyColor),
		messageBorderColor: parseStringOverride(fm.msgBorderColor),
		messageCornerRadius: parsePixelOverride(fm.msgCornerRadius, CORNER_RADIUS_MIN, CORNER_RADIUS_MAX),
		showMessageAuthor: parseBooleanOverride(fm.msgShowAuthor),
		showMessageTimestamp: parseBooleanOverride(fm.msgShowTime),
		showAuthorBadges: parseBooleanOverride(fm.msgAuthorBadges),
		contrastHeadings: parseBooleanOverride(fm.msgContrastHeadings),
		scrollOnSend: parseBooleanOverride(fm.msgScrollOnSend),
		enableButtonShadow: parseBooleanOverride(fm.msgButtonShadow)
	};
}

export function resolveConfig(
	global: ChatNotesPluginSettings,
	overrides: ChatConfig
): ChatConfig {
	return {
		...global,
		...Object.fromEntries(
			Object.entries(overrides).filter(([_, v]) => v !== undefined)
		),
	};
}
