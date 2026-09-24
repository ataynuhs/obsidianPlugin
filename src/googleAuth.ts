import { Notice, requestUrl } from 'obsidian';
import type ObSyncPlugin from './main';

export class GoogleAuth {
	plugin: ObSyncPlugin;
	private accessToken: string | null = null;
	private accessTokenExpiry: number = 0;

	constructor(plugin: ObSyncPlugin) {
		this.plugin = plugin;
	}

	startAuthFlow() {
		if (!this.plugin.settings.proxyUrl) {
			new Notice('Please provide a Proxy URL in settings first.');
			return;
		}

		const loginUrl = `${this.plugin.settings.proxyUrl}/login`;
		window.open(loginUrl);
		new Notice('Opened browser for Google Auth. Waiting for response...');
	}

	// This is called by main.ts when the obsidian://obsync-auth URI is triggered
	async handleAuthCallback(refreshToken: string, accessToken: string, expiresIn: number) {
		this.plugin.settings.refreshToken = refreshToken;
		this.accessToken = accessToken;
		this.accessTokenExpiry = Date.now() + (expiresIn * 1000) - 60000;
		await this.plugin.saveSettings();
		
		new Notice('Successfully authenticated with Google Drive!');
		// Optional: Trigger a sync immediately
		// this.plugin.syncEngine.runSync();
	}

	async getValidAccessToken(): Promise<string | null> {
		if (this.accessToken && Date.now() < this.accessTokenExpiry) {
			return this.accessToken;
		}

		if (!this.plugin.settings.refreshToken || !this.plugin.settings.proxyUrl) {
			return null;
		}

		// Refresh the token via the proxy
		try {
			const response = await requestUrl({
				url: `${this.plugin.settings.proxyUrl}/refresh`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					refresh_token: this.plugin.settings.refreshToken
				}),
			});

			if (response.status === 200) {
				const data = response.json;
				this.accessToken = data.access_token;
				this.accessTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
				return this.accessToken;
			} else {
				this.plugin.settings.refreshToken = '';
				await this.plugin.saveSettings();
				new Notice('Session expired or proxy error. Please re-authenticate.');
				return null;
			}
		} catch (e) {
			console.error("Failed to refresh token via proxy", e);
			return null;
		}
	}
}
