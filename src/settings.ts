import {App, PluginSettingTab, Setting, TFile} from "obsidian";
import ChatNotesPlugin from "./main";



export interface ChatConfig {
	// holds all possible settings for a chat (can be more than global settings)

	messageBgColor?: string;
	enableButtonShadow?: boolean;
    messageCornerRadius?: number;
	chatId?: string;
	author?: string;
	messageHighlightColor?: string;
	messageFlashColor?: string;
	// add future settings (that can be overriden in yaml) here
}


export interface ChatNotesPluginSettings extends ChatConfig {
	messageBgColor: string;
	enableButtonShadow: boolean;
    messageCornerRadius: number;
	messageHighlightColor: string;
	messageFlashColor: string;
	// specify the variables that should appear in global settings
}

export const DEFAULT_SETTINGS: ChatNotesPluginSettings = {
	messageBgColor: "#6d54b1",
	enableButtonShadow: true,
	messageCornerRadius: 12,
	messageHighlightColor: "#e0adf0",
	messageFlashColor: "white",
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
				.setValue(this.plugin.settings.messageCornerRadius)
				.setLimits(0, 50, 1) 	// min 0px, max 50px, step 1px
				.onChange(async (value) => {
					this.plugin.settings.messageCornerRadius = value;
					await this.plugin.saveSettings();
				});
		});
    }
}


export function getFileOverrides(app: App, file: TFile): ChatConfig {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
  
	if (!fm) return {};
  	
	// set variable alias names for the yaml overrides here:
	return {
		chatId: fm.chatId,
		author: fm.author,
		messageBgColor: fm.msgColor,
		messageHighlightColor: fm.msgPinColor,
		messageFlashColor: fm. msgFlashColor
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



