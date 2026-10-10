import { App, Modal, Setting } from 'obsidian';
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
		const plan = this.engine.pendingPlan;

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

		if (p.status === 'Confirming' && plan) {
			this.contentContainer.createEl('p', { text: 'Please review the planned changes before syncing:' });

			const listChanges = (title: string, items: string[], color: string, tooltip?: string) => {
				if (items.length > 0) {
					const header = this.contentContainer.createEl('h4', { text: `${title} (${items.length})` });
					header.style.color = color;
					if (tooltip) header.title = tooltip;
					
					const ul = this.contentContainer.createEl('ul');
					ul.style.maxHeight = '150px';
					ul.style.overflowY = 'auto';
					items.forEach(item => ul.createEl('li', { text: item }));
				}
			};

			if (plan.conflicts.length > 0) {
				const conflictWarning = this.contentContainer.createEl('p', {
					text: '⚠️ CONFLICTS DETECTED: Files modified on both sides. Please choose a resolution:'
				});
				conflictWarning.style.color = 'var(--text-error)';
				conflictWarning.style.fontWeight = 'bold';

				// 1. GLOBAL BULK BUTTONS
				const globalBulkDiv = this.contentContainer.createDiv();
				globalBulkDiv.style.display = 'flex';
				globalBulkDiv.style.gap = '10px';
				globalBulkDiv.style.marginBottom = '15px';

				const globalLocalBtn = globalBulkDiv.createEl('button', { text: 'Use Local for All' });
				globalLocalBtn.onclick = () => {
					plan.uploads.push(...plan.conflicts);
					plan.conflicts = [];
					this.renderData();
				};

				const globalDriveBtn = globalBulkDiv.createEl('button', { text: 'Use Drive for All' });
				globalDriveBtn.onclick = () => {
					plan.downloads.push(...plan.conflicts);
					plan.conflicts = [];
					this.renderData();
				};

				// 2. GROUP BY FOLDER
				const conflictsByFolder = new Map<string, string[]>();
				plan.conflicts.forEach(item => {
					const dir = item.includes('/') ? item.substring(0, item.lastIndexOf('/')) : 'Root';
					if (!conflictsByFolder.has(dir)) conflictsByFolder.set(dir, []);
					conflictsByFolder.get(dir)!.push(item);
				});

				const scrollContainer = this.contentContainer.createDiv();
				scrollContainer.style.maxHeight = '250px';
				scrollContainer.style.overflowY = 'auto';
				scrollContainer.style.border = '1px solid var(--background-modifier-border)';
				scrollContainer.style.padding = '10px';

				// 3. FOLDER BULK BUTTONS & INDIVIDUAL FILES
				conflictsByFolder.forEach((files, dir) => {
					const dirHeader = scrollContainer.createDiv();
					dirHeader.style.display = 'flex';
					dirHeader.style.justifyContent = 'space-between';
					dirHeader.style.alignItems = 'center';
					dirHeader.style.marginTop = '10px';
					dirHeader.style.borderBottom = '1px solid var(--background-modifier-border)';
					
					dirHeader.createEl('strong', { text: `📂 ${dir}` });

					const dirBulkDiv = dirHeader.createDiv();
					dirBulkDiv.style.display = 'flex';
					dirBulkDiv.style.gap = '5px';

					const dirLocalBtn = dirBulkDiv.createEl('button', { text: 'Local (Folder)' });
					dirLocalBtn.onclick = () => {
						plan.uploads.push(...files);
						plan.conflicts = plan.conflicts.filter(c => !files.includes(c));
						this.renderData();
					};

					const dirDriveBtn = dirBulkDiv.createEl('button', { text: 'Drive (Folder)' });
					dirDriveBtn.onclick = () => {
						plan.downloads.push(...files);
						plan.conflicts = plan.conflicts.filter(c => !files.includes(c));
						this.renderData();
					};

					const ul = scrollContainer.createEl('ul');
					ul.style.marginBottom = '15px';

					files.forEach(item => {
						const li = ul.createEl('li');
						li.style.display = 'flex';
						li.style.justifyContent = 'space-between';
						li.style.alignItems = 'center';
						li.style.marginBottom = '8px';
						
						li.createSpan({ text: item.includes('/') ? item.substring(item.lastIndexOf('/') + 1) : item });

						const btnDiv = li.createDiv();
						btnDiv.style.display = 'flex';
						btnDiv.style.gap = '5px';

						const useLocalBtn = btnDiv.createEl('button', { text: 'Local' });
						useLocalBtn.onclick = () => {
							plan.uploads.push(item);
							plan.conflicts = plan.conflicts.filter(c => c !== item);
							this.renderData();
						};

						const useDriveBtn = btnDiv.createEl('button', { text: 'Drive' });
						useDriveBtn.onclick = () => {
							plan.downloads.push(item);
							plan.conflicts = plan.conflicts.filter(c => c !== item);
							this.renderData();
						};
					});
				});
			}
			listChanges('Uploads', plan.uploads, 'var(--text-success)');
			listChanges('Downloads', plan.downloads, 'var(--text-accent)');
			listChanges('Local Deletions', plan.deletionsLocal, 'var(--text-muted)');
			listChanges('Remote Deletions', plan.deletionsRemote, 'var(--text-muted)');

			const buttonDiv = this.contentContainer.createDiv();
			buttonDiv.style.marginTop = '20px';
			buttonDiv.style.display = 'flex';
			buttonDiv.style.gap = '10px';

			const confirmBtn = buttonDiv.createEl('button', { text: 'Confirm Sync', cls: 'mod-cta' });
			confirmBtn.onclick = () => {
				this.engine.executeSync();
			};

			const cancelBtn = buttonDiv.createEl('button', { text: 'Cancel' });
			cancelBtn.onclick = () => {
				this.engine.cancelSync();
				this.close();
			};
		}

		if (p.status === 'Syncing' || p.status === 'Idle') {
			const createBar = (label: string, completed: number, total: number) => {
				const row = this.contentContainer.createDiv({ cls: 'sync-stat-row' });
				row.style.marginTop = '10px';
				row.createEl('strong', { text: `${label}: ` });
				row.createSpan({ text: `${completed} / ${total}` });
				if (total > 0) {
					const prog = row.createEl('progress');
					prog.max = total;
					prog.value = completed;
					prog.style.marginLeft = '10px';
					prog.style.width = '100%';
				}
			};

			createBar('Uploads', p.completedUploads, p.totalUploads);
			createBar('Downloads', p.completedDownloads, p.totalDownloads);
			createBar('Deletions', p.completedDeletions, p.totalDeletions);

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
