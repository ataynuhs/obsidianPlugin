import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ObSyncPlugin from './main';

export interface ObSyncSettings {
	proxyUrl: string;
	syncFolder: string;
	autoSyncInterval: number; // in minutes, 0 means manual only
	syncOnStartup: boolean;
	syncConfig: boolean;
	refreshToken: string; // Stored securely
	lastSyncTime: number;
}

export const DEFAULT_SETTINGS: ObSyncSettings = {
	proxyUrl: '', // Provide a default if you host a public one
	syncFolder: 'ObsidianSync',
	autoSyncInterval: 0,
	syncOnStartup: false,
	syncConfig: false,
	refreshToken: '',
	lastSyncTime: 0
}

export class ObSyncSettingTab extends PluginSettingTab {
	plugin: ObSyncPlugin;

	constructor(app: App, plugin: ObSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'ObSync - Google Drive Sync Settings'});

		new Setting(containerEl)
			.setName('Authentication Proxy URL')
			.setDesc('The URL of your Cloudflare Worker Proxy (e.g. https://your-worker.workers.dev)')
			.addText(text => text
				.setPlaceholder('https://...')
				.setValue(this.plugin.settings.proxyUrl)
				.onChange(async (value) => {
					// Clean up trailing slash
					this.plugin.settings.proxyUrl = value.replace(/\/$/, '');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Authenticate with Google Drive')
			.setDesc(this.plugin.settings.refreshToken ? 'You are currently authenticated.' : 'Click to authenticate and grant access to Google Drive.')
			.addButton(button => button
				.setButtonText(this.plugin.settings.refreshToken ? 'Re-Authenticate' : 'Authenticate')
				.setCta()
				.onClick(() => {
					if (!this.plugin.settings.proxyUrl) {
						new Notice('Please configure the Authentication Proxy URL first.');
						return;
					}
					this.plugin.googleAuth.startAuthFlow();
				}));
				
		if (this.plugin.settings.refreshToken) {
			new Setting(containerEl)
				.setName('Disconnect')
				.setDesc('Remove authentication tokens from this device.')
				.addButton(button => button
					.setButtonText('Disconnect')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.refreshToken = '';
						await this.plugin.saveSettings();
						this.display();
					}));
		}

		new Setting(containerEl)
			.setName('Sync Folder Name')
			.setDesc('The name of the folder in Google Drive where files will be synced.')
			.addText(text => text
				.setPlaceholder('ObsidianSync')
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Sync Interval (minutes)')
			.setDesc('How often to sync automatically in the background. Set to 0 to disable.')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(this.plugin.settings.autoSyncInterval))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num)) {
						this.plugin.settings.autoSyncInterval = num;
						await this.plugin.saveSettings();
						this.plugin.setupAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Automatically trigger a sync when Obsidian starts.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Configuration (Plugins, Themes, Snippets)')
			.setDesc('Sync the hidden .obsidian folder. Safely ignores workspace layouts and this plugin\'s auth tokens to prevent device conflicts.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncConfig)
				.onChange(async (value) => {
					this.plugin.settings.syncConfig = value;
					await this.plugin.saveSettings();
				}));
	}
}
