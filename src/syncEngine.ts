import { Notice, TFile, TFolder } from 'obsidian';
import type ObSyncPlugin from './main';
import type { DriveFile } from './googleDriveApi';
import type { SyncStatusModal } from './syncModal';

interface SyncState {
	lastSync: number;
	files: Record<string, string>; // path -> modifiedTime (ISO)
}

export interface SyncProgress {
	status: 'Idle' | 'Scanning' | 'Syncing' | 'Error';
	totalUploads: number;
	completedUploads: number;
	totalDownloads: number;
	completedDownloads: number;
	totalDeletions: number;
	completedDeletions: number;
	currentFile: string;
	errorMessage?: string;
}

export class SyncEngine {
	plugin: ObSyncPlugin;
	private syncLock = false;
	private statePath = '.obsidian/plugins/obsync/sync_state.json';
	private logPath = 'ObSync Log.md';
	
	public activeModal: SyncStatusModal | null = null;
	public statusBarItem: HTMLElement | null = null;

	public progress: SyncProgress = {
		status: 'Idle',
		totalUploads: 0,
		completedUploads: 0,
		totalDownloads: 0,
		completedDownloads: 0,
		totalDeletions: 0,
		completedDeletions: 0,
		currentFile: ''
	};

	constructor(plugin: ObSyncPlugin) {
		this.plugin = plugin;
	}

	private updateProgressUI() {
		if (this.statusBarItem) {
			if (this.progress.status === 'Idle') {
				this.statusBarItem.setText('ObSync: Up to date');
			} else if (this.progress.status === 'Scanning') {
				this.statusBarItem.setText('ObSync: Scanning...');
			} else if (this.progress.status === 'Syncing') {
				this.statusBarItem.setText(`ObSync: Up ${this.progress.completedUploads}/${this.progress.totalUploads} | Down ${this.progress.completedDownloads}/${this.progress.totalDownloads}`);
			} else if (this.progress.status === 'Error') {
				this.statusBarItem.setText('ObSync: Error');
			}
		}

		if (this.activeModal) {
			this.activeModal.renderData();
		}
	}

	private async loadState(): Promise<SyncState> {
		try {
			if (await this.plugin.app.vault.adapter.exists(this.statePath)) {
				const content = await this.plugin.app.vault.adapter.read(this.statePath);
				return JSON.parse(content);
			}
		} catch (e) {
			console.error("Failed to load sync state", e);
		}
		return { lastSync: 0, files: {} };
	}

	private async saveState(state: SyncState) {
		try {
			const dir = this.statePath.substring(0, this.statePath.lastIndexOf('/'));
			if (!(await this.plugin.app.vault.adapter.exists(dir))) {
				await this.plugin.app.vault.adapter.mkdir(dir);
			}
			await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(state, null, 2));
		} catch (e) {
			console.error("Failed to save sync state", e);
		}
	}

	private async writeLog(uploads: string[], downloads: string[], deletions: string[]) {
		let logContent = `\n## Sync: ${new Date().toLocaleString()}\n`;
		
		if (uploads.length === 0 && downloads.length === 0 && deletions.length === 0) {
			logContent += "- *No changes detected.*\n";
		} else {
			uploads.forEach(f => logContent += `- **Uploaded:** \`${f}\`\n`);
			downloads.forEach(f => logContent += `- **Downloaded:** \`${f}\`\n`);
			deletions.forEach(f => logContent += `- **Deleted:** \`${f}\`\n`);
		}

		try {
			if (await this.plugin.app.vault.adapter.exists(this.logPath)) {
				const existing = await this.plugin.app.vault.adapter.read(this.logPath);
				await this.plugin.app.vault.adapter.write(this.logPath, existing + logContent);
			} else {
				await this.plugin.app.vault.create(this.logPath, `# ObSync Log\n${logContent}`);
			}
		} catch (e) {
			console.error("Failed to write sync log", e);
		}
	}

	private async getLocalFiles(): Promise<{path: string, stat: any, name: string}[]> {
		const result: {path: string, stat: any, name: string}[] = [];
		const adapter = this.plugin.app.vault.adapter;
		
		const crawl = async (folder: string) => {
			const listed = await adapter.list(folder);
			for (const file of listed.files) {
				// Skip internal plugin state and log
				if (file === this.statePath || file === this.logPath) continue;
				// Skip trash
				if (file.startsWith('.trash/')) continue;
				
				// Handle .obsidian config sync logic
				if (file.startsWith('.obsidian/')) {
					if (!this.plugin.settings.syncConfig) continue; // Skip entirely if toggle is off
					// Always skip problematic files
					if (file.includes('workspace.json') || file.includes('workspace-mobile.json') || file.startsWith('.obsidian/plugins/obsync/')) {
						continue;
					}
				}

				const stat = await adapter.stat(file);
				if (stat) {
					result.push({
						path: file,
						stat: stat,
						name: file.includes('/') ? file.substring(file.lastIndexOf('/') + 1) : file
					});
				}
			}
			for (const subfolder of listed.folders) {
				// Skip trash
				if (subfolder.startsWith('.trash')) continue;
				// Skip .obsidian unless syncing config
				if (subfolder.startsWith('.obsidian') && !this.plugin.settings.syncConfig) continue;
				// Skip our own plugin folder to protect auth tokens
				if (subfolder === '.obsidian/plugins/obsync') continue;
				
				await crawl(subfolder);
			}
		};

		await crawl('');
		if (await adapter.exists('.handwriting')) {
			await crawl('.handwriting');
		}
		return result;
	}

	async runSync() {
		if (this.syncLock) {
			new Notice('Sync already in progress...');
			return;
		}

		if (!this.plugin.settings.refreshToken) {
			new Notice('Cannot sync: Not authenticated with Google Drive.');
			return;
		}

		this.syncLock = true;
		new Notice('Syncing with Google Drive...');

		this.progress = {
			status: 'Scanning',
			totalUploads: 0,
			completedUploads: 0,
			totalDownloads: 0,
			completedDownloads: 0,
			totalDeletions: 0,
			completedDeletions: 0,
			currentFile: ''
		};
		this.updateProgressUI();

		const uploadedFiles: string[] = [];
		const downloadedFiles: string[] = [];
		const deletedFiles: string[] = [];

		try {
			const folderName = this.plugin.settings.syncFolder;
			const rootFolderId = await this.plugin.driveApi.ensureRootFolder(folderName);
			
			const driveFiles = await this.plugin.driveApi.listAllVaultFiles(rootFolderId);
			const localFiles = await this.getLocalFiles();
			
			const state = await this.loadState();
			const newState: SyncState = { lastSync: Date.now(), files: {} };

			const driveFileMap = new Map<string, DriveFile>();
			for (const df of driveFiles) {
				driveFileMap.set(df.vaultPath, df);
			}

			const localFileMap = new Map<string, {path: string, stat: any, name: string}>();
			for (const lf of localFiles) {
				localFileMap.set(lf.path, lf);
			}

			// Pre-calculate totals for the progress bar
			for (const [path, lFile] of localFileMap.entries()) {
				const dFile = driveFileMap.get(path);
				const lTime = lFile.stat.mtime;
				if (!dFile) {
					if (state.files[path]) this.progress.totalDeletions++;
					else this.progress.totalUploads++;
				} else {
					const dTime = new Date(dFile.modifiedTime).getTime();
					if (lTime > dTime + 2000) this.progress.totalUploads++;
					else if (dTime > lTime + 2000) this.progress.totalDownloads++;
				}
			}
			for (const path of driveFileMap.keys()) {
				if (!localFileMap.has(path)) {
					if (state.files[path]) this.progress.totalDeletions++;
					else this.progress.totalDownloads++;
				}
			}

			this.progress.status = 'Syncing';
			this.updateProgressUI();

			// 1. Process Local Files (Uploads / Updates)
			for (const [path, lFile] of localFileMap.entries()) {
				const dFile = driveFileMap.get(path);
				const lModTime = new Date(lFile.stat.mtime).toISOString();
				const stateFileTime = state.files[path];

				const dirName = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
				const fileName = lFile.name;

				if (!dFile) {
					// Exists locally, not on drive
					if (stateFileTime) {
						// Was deleted on drive -> delete locally
						this.progress.currentFile = path; this.updateProgressUI();
						await this.plugin.app.vault.adapter.remove(path);
						deletedFiles.push(path);
						this.progress.completedDeletions++;
					} else {
						// Truly new locally, upload
						this.progress.currentFile = path; this.updateProgressUI();
						const targetFolderId = await this.plugin.driveApi.getOrCreateFolderTree(dirName, rootFolderId);
						const content = await this.plugin.app.vault.adapter.readBinary(path);
						await this.plugin.driveApi.uploadFile(targetFolderId, fileName, path, rootFolderId, content, undefined, lModTime);
						newState.files[path] = lModTime;
						uploadedFiles.push(path);
						this.progress.completedUploads++;
					}
				} else {
					// Exists in both
					const dModTime = dFile.modifiedTime;
					
					const lTime = lFile.stat.mtime;
					const dTime = new Date(dModTime).getTime();

					if (lTime > dTime + 2000) {
						// Local is newer
						this.progress.currentFile = path; this.updateProgressUI();
						const targetFolderId = await this.plugin.driveApi.getOrCreateFolderTree(dirName, rootFolderId);
						const content = await this.plugin.app.vault.adapter.readBinary(path);
						await this.plugin.driveApi.uploadFile(targetFolderId, fileName, path, rootFolderId, content, dFile.id, lModTime);
						newState.files[path] = lModTime;
						uploadedFiles.push(path);
						this.progress.completedUploads++;
					} else if (dTime > lTime + 2000) {
						// Remote is newer
						this.progress.currentFile = path; this.updateProgressUI();
						const content = await this.plugin.driveApi.downloadFile(dFile.id);
						await this.plugin.app.vault.adapter.writeBinary(path, content);
						newState.files[path] = new Date((await this.plugin.app.vault.adapter.stat(path))!.mtime).toISOString();
						downloadedFiles.push(path);
						this.progress.completedDownloads++;
					} else {
						// In sync
						newState.files[path] = lModTime;
					}
				}
			}

			// 2. Process Remote Files (Downloads for new files, remote deletions)
			for (const [path, dFile] of driveFileMap.entries()) {
				if (!localFileMap.has(path)) {
					const stateFileTime = state.files[path];
					if (stateFileTime) {
						// Was locally deleted -> delete on drive
						this.progress.currentFile = path; this.updateProgressUI();
						await this.plugin.driveApi.deleteFile(dFile.id);
						deletedFiles.push(path);
						this.progress.completedDeletions++;
					} else {
						// Truly new on drive -> download
						this.progress.currentFile = path; this.updateProgressUI();
						const content = await this.plugin.driveApi.downloadFile(dFile.id);
						
						// Ensure local folders exist
						const parts = path.split('/');
						parts.pop();
						let currentPath = '';
						for (const part of parts) {
							currentPath += (currentPath === '' ? '' : '/') + part;
							if (!(await this.plugin.app.vault.adapter.exists(currentPath))) {
								await this.plugin.app.vault.adapter.mkdir(currentPath);
							}
						}

						await this.plugin.app.vault.adapter.writeBinary(path, content);
						newState.files[path] = new Date((await this.plugin.app.vault.adapter.stat(path))!.mtime).toISOString();
						downloadedFiles.push(path);
						this.progress.completedDownloads++;
					}
				}
			}

			await this.saveState(newState);
			await this.writeLog(uploadedFiles, downloadedFiles, deletedFiles);
			
			this.plugin.settings.lastSyncTime = Date.now();
			await this.plugin.saveSettings();

			this.progress.status = 'Idle';
			this.progress.currentFile = '';
			this.updateProgressUI();

			new Notice(`Sync Complete! Up: ${uploadedFiles.length}, Down: ${downloadedFiles.length}, Del: ${deletedFiles.length}`);
		} catch (error) {
			console.error("Sync error:", error);
			this.progress.status = 'Error';
			this.progress.errorMessage = error.message;
			this.updateProgressUI();
			new Notice(`Sync failed: ${error.message}`);
		} finally {
			this.syncLock = false;
		}
	}
}
