import {App, PluginSettingTab, Setting, TFile} from "obsidian";
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
	chatId?: string;
	author?: string;
	messageHighlightColor?: string;
	messageFlashColor?: string;
	messageReplyColor?: string;
	messageBorderColor?: string;
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
	messageHighlightColor: string;
	messageFlashColor: string;
	messageReplyColor: string;
	messageBorderColor: string;
	inputMaxHeight: number;
	inputWidthOffset: number;
	defaultAuthorMode: DefaultAuthorMode;
	showRibbonIcon: boolean;
	// specify the variables that should appear in global settings
}

// shared by the settings slider and the YAML override parser, so the two can't drift apart
export const CORNER_RADIUS_MIN = 0;
export const CORNER_RADIUS_MAX = 50;

export const DEFAULT_SETTINGS: ChatNotesPluginSettings = {
	messageBgColor: "#6d54b1",
	enableButtonShadow: true,
	showMessageAuthor: true,
	showMessageTimestamp: true,
	showAuthorBadges: false,
	scrollOnSend: false,
	messageCornerRadius: 12,
	messageHighlightColor: "#e0adf0",
	messageFlashColor: "white",
	messageReplyColor: "#57467e",
	messageBorderColor: "#808080",
	inputMaxHeight: 200,
	inputWidthOffset: 0,
	defaultAuthorMode: "owner",
	showRibbonIcon: true,
	// add default values here
};


export class ChatNotesSettingTab extends PluginSettingTab {
    plugin: ChatNotesPlugin;

    constructor(app: App, plugin: ChatNotesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Message background color")
            .setDesc("Determines the background color of message bubbles")
            .addColorPicker(color => {
                color
                    .setValue(this.plugin.settings.messageBgColor)
                    .onChange(async (value) => {
                        this.plugin.settings.messageBgColor = value;
                        await this.plugin.saveSettings();
                    });
            });

		new Setting(containerEl)
		.setName("Message highlight color")
		.setDesc("Determines the background color of a highlighted/pinned message")
		.addColorPicker(color => {
			color
				.setValue(this.plugin.settings.messageHighlightColor)
				.onChange(async (value) => {
					this.plugin.settings.messageHighlightColor = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Message flash color")
		.setDesc("Determines the color for the short flash highlighting when scrolling to a specific message")
		.addColorPicker(color => {
			color
				.setValue(this.plugin.settings.messageFlashColor)
				.onChange(async (value) => {
					this.plugin.settings.messageFlashColor = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Reply banner color")
		.setDesc("Determines the background color of the 'reply to' banner shown on messages that reply to another one")
		.addColorPicker(color => {
			color
				.setValue(this.plugin.settings.messageReplyColor)
				.onChange(async (value) => {
					this.plugin.settings.messageReplyColor = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Message border color")
		.setDesc("Determines the outline color of message bubbles and the chat input field")
		.addColorPicker(color => {
			color
				.setValue(this.plugin.settings.messageBorderColor)
				.onChange(async (value) => {
					this.plugin.settings.messageBorderColor = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Enable button shadow")
		.setDesc("Toggle shadow on message action buttons")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.enableButtonShadow)
				.onChange(async (value) => {
					this.plugin.settings.enableButtonShadow = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Show message author")
		.setDesc("Show the author name in the header of every message. Override per file with 'msgShowAuthor: true' or 'msgShowAuthor: false'.")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.showMessageAuthor)
				.onChange(async (value) => {
					this.plugin.settings.showMessageAuthor = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Show message time")
		.setDesc("Show the timestamp in the header of every message. Override per file with 'msgShowTime: true' or 'msgShowTime: false'.")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.showMessageTimestamp)
				.onChange(async (value) => {
					this.plugin.settings.showMessageTimestamp = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Show author badges")
		.setDesc("Give each message a speech-bubble tail with the author's avatar and name beside it, in the gutter - on the right for the chat owner (the file's 'author' YAML key) and on the left for everyone else. Widens the gutter slightly while on. Override per file with 'msgAuthorBadges: true' or 'msgAuthorBadges: false'.")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.showAuthorBadges)
				.onChange(async (value) => {
					this.plugin.settings.showAuthorBadges = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Message corner radius")
		.setDesc("Determines how round corners of the message bubbles are. Override per file with 'msgCornerRadius: 20'.")
		.addSlider(slider => {
			slider
				.setLimits(CORNER_RADIUS_MIN, CORNER_RADIUS_MAX, 1) 	// step 1px
				.setValue(this.plugin.settings.messageCornerRadius)
				.onChange(async (value) => {
					this.plugin.settings.messageCornerRadius = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Default message author")
		.setDesc("Which author a new message is sent as when its author field is left empty. Override per file with 'msgDefaultAuthor: owner' or 'msgDefaultAuthor: previous'; the chat owner itself is the file's 'author' YAML key.")
		.addDropdown(dropdown => {
			dropdown
				.addOption("owner", "Chat owner")
				.addOption("previous", "Previous message's author")
				.setValue(this.plugin.settings.defaultAuthorMode)
				.onChange(async (value) => {
					this.plugin.settings.defaultAuthorMode = value as DefaultAuthorMode;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Scroll to bottom on send")
		.setDesc("Jump to the end of the chat every time a message is sent. Override per file with 'msgScrollOnSend: true' or 'msgScrollOnSend: false'.")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.scrollOnSend)
				.onChange(async (value) => {
					this.plugin.settings.scrollOnSend = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Show ribbon icon")
		.setDesc("Show a 'Create new chat note' button in the left ribbon. The command itself stays available from the command palette either way, and can be given a hotkey there.")
		.addToggle(toggle => {
			toggle
				.setValue(this.plugin.settings.showRibbonIcon)
				.onChange(async (value) => {
					this.plugin.settings.showRibbonIcon = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Input field width offset")
		.setDesc("Widens or narrows the message input field relative to the message bubbles it sits under. At 0 its edges line up with the messages.")
		.addSlider(slider => {
			slider
				.setLimits(-150, 150, 5) 	// min -150px, max +150px, step 5px
				.setValue(this.plugin.settings.inputWidthOffset)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.inputWidthOffset = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
		.setName("Max input field height")
		.setDesc("Determines how tall the message input field can grow before it starts scrolling")
		.addSlider(slider => {
			slider
				.setLimits(60, 600, 20) 	// min 60px, max 600px, step 20px
				.setValue(this.plugin.settings.inputMaxHeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.inputMaxHeight = value;
					await this.plugin.saveSettings();
				});
		});
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

export function getFileOverrides(app: App, file: TFile): ChatConfig {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;

	if (!fm) return {};

	// only a recognised mode counts as an override; a typo falls through to the global one
	const defaultAuthorMode: DefaultAuthorMode | undefined =
		fm.msgDefaultAuthor === "owner" || fm.msgDefaultAuthor === "previous"
			? fm.msgDefaultAuthor
			: undefined;

	// set variable alias names for the yaml overrides here:
	return {
		chatId: fm.chatId,
		author: fm.author,			// the chat owner - yaml only, never a global setting
		defaultAuthorMode,
		messageBgColor: fm.msgColor,
		messageHighlightColor: fm.msgPinColor,
		messageFlashColor: fm. msgFlashColor,
		messageReplyColor: fm.msgReplyColor,
		messageBorderColor: fm.msgBorderColor,
		messageCornerRadius: parsePixelOverride(fm.msgCornerRadius, CORNER_RADIUS_MIN, CORNER_RADIUS_MAX),
		showMessageAuthor: parseBooleanOverride(fm.msgShowAuthor),
		showMessageTimestamp: parseBooleanOverride(fm.msgShowTime),
		showAuthorBadges: parseBooleanOverride(fm.msgAuthorBadges),
		scrollOnSend: parseBooleanOverride(fm.msgScrollOnSend)
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



