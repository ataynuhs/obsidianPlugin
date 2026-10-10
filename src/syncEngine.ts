import { Notice, TFile, TFolder } from 'obsidian';
import type ObSyncPlugin from './main';
import type { DriveFile } from './googleDriveApi';
import type { SyncStatusModal } from './syncModal';

export interface FileState {
	local: number;
	drive: string;
}

export interface SyncState {
	lastSync: number;
	files: Record<string, FileState | string>; // Allow string for legacy migration
}

export interface SyncProgress {
	status: 'Idle' | 'Scanning' | 'Confirming' | 'Syncing' | 'Error';
	totalUploads: number;
	completedUploads: number;
	totalDownloads: number;
	completedDownloads: number;
	totalDeletions: number;
	completedDeletions: number;
	currentFile: string;
	errorMessage?: string;
}

export interface SyncPlan {
	uploads: string[];
	downloads: string[];
	deletionsLocal: string[];
	deletionsRemote: string[];
	conflicts: string[];
	driveFiles: Map<string, DriveFile>;
	localFiles: Map<string, {path: string, stat: any, name: string}>;
	state: SyncState;
	rootFolderId: string;
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
	
	public pendingPlan: SyncPlan | null = null;

	constructor(plugin: ObSyncPlugin) {
		this.plugin = plugin;
	}

	public updateProgressUI() {
		if (this.statusBarItem) {
			if (this.progress.status === 'Idle') {
				this.statusBarItem.setText('ObSync: Up to date');
			} else if (this.progress.status === 'Scanning') {
				this.statusBarItem.setText('ObSync: Scanning...');
			} else if (this.progress.status === 'Confirming') {
				this.statusBarItem.setText('ObSync: Awaiting Confirmation');
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

	private async writeLog(uploads: string[], downloads: string[], deletions: string[], conflicts: string[]) {
		let logContent = `\n## Sync: ${new Date().toLocaleString()}\n`;
		
		if (uploads.length === 0 && downloads.length === 0 && deletions.length === 0 && conflicts.length === 0) {
			logContent += "- *No changes detected.*\n";
		} else {
			conflicts.forEach(f => logContent += `- **CONFLICT RESOLVED:** \`${f}\`\n`);
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
				if (file === this.statePath || file === this.logPath) continue;
				if (file.startsWith('.trash/')) continue;
				
				if (file.startsWith('.obsidian/')) {
					if (!this.plugin.settings.syncConfig) continue;
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
				if (subfolder.startsWith('.trash')) continue;
				if (subfolder.startsWith('.obsidian') && !this.plugin.settings.syncConfig) continue;
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
		this.pendingPlan = null;
		
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

		try {
			const folderName = this.plugin.settings.syncFolder;
			const rootFolderId = await this.plugin.driveApi.ensureRootFolder(folderName);
			
			const driveFiles = await this.plugin.driveApi.listAllVaultFiles(rootFolderId);
			const localFiles = await this.getLocalFiles();
			const state = await this.loadState();

			const driveFileMap = new Map<string, DriveFile>();
			for (const df of driveFiles) {
				driveFileMap.set(df.vaultPath, df);
			}

			const localFileMap = new Map<string, {path: string, stat: any, name: string}>();
			for (const lf of localFiles) {
				localFileMap.set(lf.path, lf);
			}

			const plan: SyncPlan = {
				uploads: [],
				downloads: [],
				deletionsLocal: [],
				deletionsRemote: [],
				conflicts: [],
				driveFiles: driveFileMap,
				localFiles: localFileMap,
				state,
				rootFolderId
			};

			// 1. Process Local Files (Uploads, Local Deletions, Conflicts)
			for (const [path, lFile] of localFileMap.entries()) {
				const dFile = driveFileMap.get(path);
				const lTime = lFile.stat.mtime;
				const stateFile = state.files[path];
				
				let localChanged = true;
				if (stateFile) {
					const stateLocalTime = typeof stateFile === 'string' ? new Date(stateFile).getTime() : stateFile.local;
					localChanged = Math.abs(lTime - stateLocalTime) > 2000;
				}

				if (!dFile) {
					// Exists locally, but not on drive
					if (stateFile && !localChanged) {
						// Deleted remotely, not modified locally -> delete locally
						plan.deletionsLocal.push(path);
					} else {
						// Truly new locally, or modified locally after drive deletion -> upload
						plan.uploads.push(path);
					}
				} else {
					// Exists in both places
					const dTime = new Date(dFile.modifiedTime).getTime();
					let remoteChanged = true;
					if (stateFile) {
						if (typeof stateFile === 'string') {
							// Legacy Migration: Fallback to old absolute time guard
							remoteChanged = dTime > lTime + 2000;
						} else {
							const stateDriveTime = new Date(stateFile.drive).getTime();
							remoteChanged = Math.abs(dTime - stateDriveTime) > 2000;
						}
					}
					
					const isConflict = stateFile && localChanged && remoteChanged;

					if (!stateFile) {
						// EMERGENCY FALLBACK: No state (first sync or reset). Use Last Write Wins.
						if (lTime > dTime + 2000) {
							plan.uploads.push(path);
						} else if (dTime > lTime + 2000) {
							plan.downloads.push(path);
						}
					} else if (isConflict) {
						plan.conflicts.push(path);
					} else if (localChanged) {
						plan.uploads.push(path);
					} else if (remoteChanged) {
						plan.downloads.push(path);
					}
				}
			}

			// 2. Process Remote Files (Downloads, Remote Deletions)
			for (const [path, dFile] of driveFileMap.entries()) {
				if (!localFileMap.has(path)) {
					const stateFile = state.files[path];
					const dTime = new Date(dFile.modifiedTime).getTime();
					
					let remoteChanged = true;
					if (stateFile) {
						if (typeof stateFile === 'string') {
							// Legacy Migration: local file was deleted, assume remote is unchanged so we can delete it
							remoteChanged = false;
						} else {
							const stateDriveTime = new Date(stateFile.drive).getTime();
							remoteChanged = Math.abs(dTime - stateDriveTime) > 2000;
						}
					}

					if (stateFile && !remoteChanged) {
						// Deleted locally, not modified on drive -> delete remotely
						plan.deletionsRemote.push(path);
					} else {
						// Truly new on drive, or modified on drive after local deletion -> download
						if (!plan.downloads.includes(path) && !plan.conflicts.includes(path)) {
							plan.downloads.push(path);
						}
					}
				}
			}

			this.progress.totalUploads = plan.uploads.length + plan.conflicts.length; // Conflict resolution uploads the local file
			this.progress.totalDownloads = plan.downloads.length + plan.conflicts.length; // Conflict resolution downloads the remote file
			this.progress.totalDeletions = plan.deletionsLocal.length + plan.deletionsRemote.length;
			
			if (this.progress.totalUploads === 0 && this.progress.totalDownloads === 0 && this.progress.totalDeletions === 0) {
				this.progress.status = 'Idle';
				this.updateProgressUI();
				new Notice('Sync Complete! No changes detected.');
				this.syncLock = false;
				return;
			}

			this.pendingPlan = plan;
			this.progress.status = 'Confirming';
			this.updateProgressUI();

		} catch (error) {
			console.error("Sync error:", error);
			this.progress.status = 'Error';
			this.progress.errorMessage = error.message;
			this.updateProgressUI();
			new Notice(`Sync failed: ${error.message}`);
			this.syncLock = false;
		}
	}
	
	public cancelSync() {
		this.pendingPlan = null;
		this.syncLock = false;
		this.progress.status = 'Idle';
		this.updateProgressUI();
		new Notice('Sync Cancelled.');
	}

	public async executeSync() {
		if (!this.pendingPlan) return;
		
		const plan = this.pendingPlan;
		this.pendingPlan = null;
		
		this.progress.status = 'Syncing';
		this.updateProgressUI();
		
		const uploadedFiles: string[] = [];
		const downloadedFiles: string[] = [];
		const deletedFiles: string[] = [];
		const conflictFiles: string[] = [];
		const newState: SyncState = { lastSync: Date.now(), files: {} };

		try {
			// Persist untouched state
			for (const path of Object.keys(plan.state.files)) {
				newState.files[path] = plan.state.files[path];
			}

			// 1. Local Deletions
			for (const path of plan.deletionsLocal) {
				this.progress.currentFile = path; this.updateProgressUI();
				if (await this.plugin.app.vault.adapter.exists(path)) {
					await this.plugin.app.vault.adapter.remove(path);
				}
				delete newState.files[path];
				deletedFiles.push(path);
				this.progress.completedDeletions++;
			}

			// 2. Conflicts
			for (const path of plan.conflicts) {
				this.progress.currentFile = `[CONFLICT] ${path}`; this.updateProgressUI();
				const lFile = plan.localFiles.get(path)!;
				const dFile = plan.driveFiles.get(path)!;
				
				// A) Download remote to a conflict file
				const extMatch = path.match(/(\.[^.]+)$/);
				const ext = extMatch ? extMatch[1] : '';
				const conflictPath = path.replace(/(\.[^.]+)$/, '') + ' (Conflict)' + ext;
				
				const remoteContent = await this.plugin.driveApi.downloadFile(dFile.id);
				await this.plugin.app.vault.adapter.writeBinary(conflictPath, remoteContent);
				this.progress.completedDownloads++;
				
				// B) Upload local file to overwrite remote
				const lModTime = new Date(lFile.stat.mtime).toISOString();
				const dirName = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
				const targetFolderId = await this.plugin.driveApi.getOrCreateFolderTree(dirName, plan.rootFolderId);
				const localContent = await this.plugin.app.vault.adapter.readBinary(path);
				
				const dFileRes = await this.plugin.driveApi.uploadFile(targetFolderId, lFile.name, path, plan.rootFolderId, localContent, dFile.id, lModTime);
				newState.files[path] = { local: lFile.stat.mtime, drive: dFileRes.modifiedTime };
				
				conflictFiles.push(path);
				this.progress.completedUploads++;
			}

			// 3. Uploads
			for (const path of plan.uploads) {
				this.progress.currentFile = path; this.updateProgressUI();
				const lFile = plan.localFiles.get(path)!;
				const dFile = plan.driveFiles.get(path);
				const lModTime = new Date(lFile.stat.mtime).toISOString();
				const dirName = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
				const targetFolderId = await this.plugin.driveApi.getOrCreateFolderTree(dirName, plan.rootFolderId);
				const content = await this.plugin.app.vault.adapter.readBinary(path);
				
				const dFileRes = await this.plugin.driveApi.uploadFile(targetFolderId, lFile.name, path, plan.rootFolderId, content, dFile ? dFile.id : undefined, lModTime);
				newState.files[path] = { local: lFile.stat.mtime, drive: dFileRes.modifiedTime };
				uploadedFiles.push(path);
				this.progress.completedUploads++;
			}

			// 4. Remote Deletions
			for (const path of plan.deletionsRemote) {
				this.progress.currentFile = path; this.updateProgressUI();
				const dFile = plan.driveFiles.get(path);
				if (dFile) {
					await this.plugin.driveApi.deleteFile(dFile.id);
				}
				delete newState.files[path];
				deletedFiles.push(path);
				this.progress.completedDeletions++;
			}

			// 5. Downloads
			for (const path of plan.downloads) {
				this.progress.currentFile = path; this.updateProgressUI();
				const dFile = plan.driveFiles.get(path)!;
				const content = await this.plugin.driveApi.downloadFile(dFile.id);
				
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
				const newStat = await this.plugin.app.vault.adapter.stat(path);
				newState.files[path] = { local: newStat!.mtime, drive: dFile.modifiedTime };
				downloadedFiles.push(path);
				this.progress.completedDownloads++;
			}

			// 6. Unchanged Files
			for (const path of plan.localFiles.keys()) {
				if (!plan.uploads.includes(path) && !plan.deletionsLocal.includes(path) && !plan.downloads.includes(path) && !plan.conflicts.includes(path)) {
					const lFile = plan.localFiles.get(path)!;
					const oldState = plan.state.files[path];
					const dFile = plan.driveFiles.get(path);
					newState.files[path] = { 
						local: lFile.stat.mtime, 
						drive: dFile ? dFile.modifiedTime : (typeof oldState === 'string' ? oldState : oldState.drive) 
					};
				}
			}

			await this.saveState(newState);
			await this.writeLog(uploadedFiles, downloadedFiles, deletedFiles, conflictFiles);
			
			this.plugin.settings.lastSyncTime = Date.now();
			await this.plugin.saveSettings();

			this.progress.status = 'Idle';
			this.progress.currentFile = '';
			this.updateProgressUI();

			new Notice(`Sync Complete! Up: ${uploadedFiles.length}, Down: ${downloadedFiles.length}, Del: ${deletedFiles.length}, Conflicts: ${conflictFiles.length}`);
		} catch (error) {
			console.error("Sync execute error:", error);
			this.progress.status = 'Error';
			this.progress.errorMessage = error.message;
			this.updateProgressUI();
			new Notice(`Sync failed: ${error.message}`);
		} finally {
			this.syncLock = false;
		}
	}
}
