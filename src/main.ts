import { Plugin, ObsidianProtocolData } from 'obsidian';
import { ObSyncSettings, DEFAULT_SETTINGS, ObSyncSettingTab } from './settings';
import { GoogleAuth } from './googleAuth';
import { GoogleDriveApi } from './googleDriveApi';
import { SyncEngine } from './syncEngine';
import { SyncStatusModal } from './syncModal';

export default class ObSyncPlugin extends Plugin {
	settings: ObSyncSettings;
	googleAuth: GoogleAuth;
	driveApi: GoogleDriveApi;
	syncEngine: SyncEngine;
	private autoSyncIntervalId: number | null = null;
	statusBarItemEl: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.googleAuth = new GoogleAuth(this);
		this.driveApi = new GoogleDriveApi(this.googleAuth);
		this.syncEngine = new SyncEngine(this);

		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText('ObSync: Idle');
		this.statusBarItemEl.addClass('mod-clickable');
		this.statusBarItemEl.onClickEvent(() => {
			new SyncStatusModal(this.app, this.syncEngine).open();
		});
		
		this.syncEngine.statusBarItem = this.statusBarItemEl;

		this.addSettingTab(new ObSyncSettingTab(this.app, this));

		this.addRibbonIcon('refresh-cw', 'ObSync: Sync with Google Drive', (evt: MouseEvent) => {
			this.syncEngine.runSync();
		});

		this.addCommand({
			id: 'obsync-start-sync',
			name: 'Start Sync',
			callback: () => {
				this.syncEngine.runSync();
			}
		});

		// Register the custom URI handler: obsidian://obsync-auth?refresh_token=...
		this.registerObsidianProtocolHandler('obsync-auth', async (e: ObsidianProtocolData) => {
			if (e.refresh_token && e.access_token && e.expires_in) {
				const expiresIn = parseInt(e.expires_in, 10) || 3600;
				await this.googleAuth.handleAuthCallback(e.refresh_token, e.access_token, expiresIn);
				
				// Re-render settings tab if it's currently open
				const settingTab = this.app.setting.activeTab;
				if (settingTab instanceof ObSyncSettingTab) {
					settingTab.display();
				}
			}
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncOnStartup) {
				this.syncEngine.runSync();
			}
			this.setupAutoSync();
		});
	}

	onunload() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setupAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		if (this.settings.autoSyncInterval > 0) {
			const ms = this.settings.autoSyncInterval * 60 * 1000;
			this.autoSyncIntervalId = window.setInterval(() => {
				this.syncEngine.runSync();
			}, ms);
			
			this.registerInterval(this.autoSyncIntervalId);
		}
	}
}
