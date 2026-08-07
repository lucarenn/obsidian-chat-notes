import {App, PluginSettingTab, Setting, TFile} from "obsidian";
import ChatNotesPlugin from "./main";



/* Which author a new message defaults to when the input's author field is left empty:
   the file's chat owner (the YAML `author` key) or whoever sent the previous message. */
export type DefaultAuthorMode = "owner" | "previous";


export interface ChatConfig {
	// holds all possible settings for a chat to override global settings
	// (can contain more than global settings)

	defaultAuthorMode?: DefaultAuthorMode;
	messageBgColor?: string;
	enableButtonShadow?: boolean;
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
    messageCornerRadius: number;
	messageHighlightColor: string;
	messageFlashColor: string;
	messageReplyColor: string;
	messageBorderColor: string;
	inputMaxHeight: number;
	defaultAuthorMode: DefaultAuthorMode;
	// specify the variables that should appear in global settings
}

export const DEFAULT_SETTINGS: ChatNotesPluginSettings = {
	messageBgColor: "#6d54b1",
	enableButtonShadow: true,
	messageCornerRadius: 12,
	messageHighlightColor: "#e0adf0",
	messageFlashColor: "white",
	messageReplyColor: "#57467e",
	messageBorderColor: "#808080",
	inputMaxHeight: 200,
	defaultAuthorMode: "owner",
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
		.setName("Message corner radius")
		.setDesc("Determines how round corners of the message bubbles are")
		.addSlider(slider => {
			slider
				.setLimits(0, 50, 1) 	// min 0px, max 50px, step 1px
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


export function getFileOverrides(app: App, file: TFile): ChatConfig {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
  
	if (!fm) return {};

	// YAML holds whatever the user typed, so only a recognised mode counts as an
	// override - a typo falls through to the global setting instead of silently
	// resolving to something the user never picked
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
		messageBorderColor: fm.msgBorderColor
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



