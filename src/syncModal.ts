import { App, Modal } from 'obsidian';
import type { SyncEngine } from './syncEngine';

export class SyncStatusModal extends Modal {
	engine: SyncEngine;
	contentContainer: HTMLElement;

	constructor(app: App, engine: SyncEngine) {
		super(app);
		this.engine = engine;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'ObSync Status' });
		
		this.contentContainer = contentEl.createDiv();
		this.renderData();

		// Register the modal with the engine so it can trigger re-renders
		this.engine.activeModal = this;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.engine.activeModal = null;
	}

	renderData() {
		if (!this.contentContainer) return;
		this.contentContainer.empty();

		const p = this.engine.progress;

		const statusEl = this.contentContainer.createEl('h3', { 
			text: `Status: ${p.status}` 
		});
		
		if (p.status === 'Error' && p.errorMessage) {
			statusEl.style.color = 'var(--text-error)';
			this.contentContainer.createEl('p', { text: p.errorMessage, cls: 'error-message' });
		}

		if (p.status === 'Scanning') {
			this.contentContainer.createEl('p', { text: 'Scanning local vault and Google Drive metadata...' });
		}

		if (p.status === 'Syncing' || p.status === 'Idle') {
			// Uploads
			const upDiv = this.contentContainer.createDiv({ cls: 'sync-stat-row' });
			upDiv.style.marginTop = '10px';
			upDiv.createEl('strong', { text: 'Uploads: ' });
			upDiv.createSpan({ text: `${p.completedUploads} / ${p.totalUploads}` });
			
			if (p.totalUploads > 0) {
				const upProgress = upDiv.createEl('progress');
				upProgress.max = p.totalUploads;
				upProgress.value = p.completedUploads;
				upProgress.style.marginLeft = '10px';
				upProgress.style.width = '100%';
			}

			// Downloads
			const downDiv = this.contentContainer.createDiv({ cls: 'sync-stat-row' });
			downDiv.style.marginTop = '10px';
			downDiv.createEl('strong', { text: 'Downloads: ' });
			downDiv.createSpan({ text: `${p.completedDownloads} / ${p.totalDownloads}` });
			
			if (p.totalDownloads > 0) {
				const downProgress = downDiv.createEl('progress');
				downProgress.max = p.totalDownloads;
				downProgress.value = p.completedDownloads;
				downProgress.style.marginLeft = '10px';
				downProgress.style.width = '100%';
			}

			// Deletions
			const delDiv = this.contentContainer.createDiv({ cls: 'sync-stat-row' });
			delDiv.style.marginTop = '10px';
			delDiv.createEl('strong', { text: 'Deletions: ' });
			delDiv.createSpan({ text: `${p.completedDeletions} / ${p.totalDeletions}` });

			// Current File
			if (p.status === 'Syncing' && p.currentFile) {
				const fileDiv = this.contentContainer.createDiv();
				fileDiv.style.marginTop = '20px';
				fileDiv.style.padding = '10px';
				fileDiv.style.backgroundColor = 'var(--background-secondary)';
				fileDiv.style.borderRadius = '5px';
				fileDiv.createEl('strong', { text: 'Current File: ' });
				fileDiv.createEl('div', { text: p.currentFile, cls: 'current-file-name' });
			}
		}
	}
}
