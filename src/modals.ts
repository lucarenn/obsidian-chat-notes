import { Modal, App } from "obsidian";

export class ConfirmDeleteModal extends Modal {
    /* Pop up window to confirm the deletion of a message */
    
    onConfirm: () => void;

    constructor(app: App, onConfirm: () => void) {
        super(app);
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h3", { text: "Delete message?" });

        contentEl.createEl("p", {
            text: "Are you sure you want to delete this message?"
        });

        const buttonContainer = contentEl.createDiv({
            cls: "msg-delete-confirm-buttons"
        });

        const cancelBtn = buttonContainer.createEl("button", {
            text: "Cancel"
        });

        const deleteBtn = buttonContainer.createEl("button", {
            text: "Delete",
            cls: "mod-warning"
        });

        cancelBtn.onclick = () => this.close();

        deleteBtn.onclick = () => {
            this.onConfirm();
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

