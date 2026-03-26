import {App, PluginSettingTab, Setting} from "obsidian";
import ChatNotesPlugin from "./main";


export interface ChatNotesPluginSettings {
	messageBgColor: string;
	enableButtonShadow: boolean;
    messageCornerRadius: number;
}

export const DEFAULT_SETTINGS: ChatNotesPluginSettings = {
	messageBgColor: "#6d54b1",
	enableButtonShadow: true,
	messageCornerRadius: 12,
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
            .setDesc("Color of Message bubbles")
            .addColorPicker(color => {
                color
                    .setValue(this.plugin.settings.messageBgColor)
                    .onChange(async (value) => {
                        this.plugin.settings.messageBgColor = value;
                        await this.plugin.saveSettings();
                    });
            });

		new Setting(containerEl)
		.setName("Enable button shadow")
		.setDesc("Toggle shadow on message buttons")
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
		.setDesc("Determines how round the speechbubbles of the messages are")
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