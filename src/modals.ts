import { Modal, App } from "obsidian";

export interface ConfirmModalText {
    title: string;
    body: string;
    confirmText: string;
}

export class ConfirmModal extends Modal {

    text: ConfirmModalText;
    onConfirm: () => void;

    constructor(app: App, text: ConfirmModalText, onConfirm: () => void) {
        super(app);
        this.text = text;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h3", { text: this.text.title });

        contentEl.createEl("p", { text: this.text.body });

        const buttonContainer = contentEl.createDiv({
            cls: "chat-confirm-buttons"
        });

        const cancelBtn = buttonContainer.createEl("button", {
            text: "Cancel"
        });

        const confirmBtn = buttonContainer.createEl("button", {
            text: this.text.confirmText,
            cls: "mod-warning"
        });

        cancelBtn.onclick = () => this.close();

        confirmBtn.onclick = () => {
            this.onConfirm();
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class ConfirmDeleteModal extends ConfirmModal {

    constructor(app: App, onConfirm: () => void) {
        super(app, {
            title: "Delete message?",
            body: "Are you sure you want to delete this message?",
            confirmText: "Delete"
        }, onConfirm);
    }
}
