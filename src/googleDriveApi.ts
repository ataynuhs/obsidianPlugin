import { requestUrl } from 'obsidian';
import type { GoogleAuth } from './googleAuth';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	vaultPath: string; // Stored in appProperties
}

export class GoogleDriveApi {
	private auth: GoogleAuth;
	private folderCache = new Map<string, string>(); // path -> folderId

	constructor(auth: GoogleAuth) {
		this.auth = auth;
	}

	private async request(url: string, method: string = 'GET', body?: any, contentType?: string, returnType: 'json' | 'arraybuffer' = 'json', retries = 3): Promise<any> {
		const token = await this.auth.getValidAccessToken();
		if (!token) throw new Error('Not authenticated');

		const headers: Record<string, string> = {
			'Authorization': `Bearer ${token}`
		};

		let requestBody: string | ArrayBuffer | undefined = undefined;

		if (body) {
			if (contentType) {
				headers['Content-Type'] = contentType;
				requestBody = body;
			} else {
				headers['Content-Type'] = 'application/json';
				requestBody = JSON.stringify(body);
			}
		}

		// Global throttle to prevent bursting the API
		await new Promise(resolve => window.setTimeout(resolve, 150));

		let attempt = 0;
		while (attempt <= retries) {
			attempt++;
			const response = await requestUrl({
				url,
				method,
				headers,
				body: requestBody,
				throw: false // Crucial: don't auto-throw so we can parse the real error!
			});

			if (response.status >= 200 && response.status < 300) {
				if (returnType === 'arraybuffer') {
					return response.arrayBuffer;
				}
				return response.json;
			}

			// If it's a rate limit error (403 or 429) and we have retries left, back off
			if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt <= retries) {
				const backoffTime = attempt * 2000; // 2s, 4s, 6s
				console.log(`Drive API rate limited/server error (${response.status}). Retrying in ${backoffTime}ms...`);
				await new Promise(resolve => window.setTimeout(resolve, backoffTime));
				continue;
			}

			// If we run out of retries or it's a fatal error (like 400 or 401), parse the exact message
			let errorMsg = response.text;
			try {
				const parsed = JSON.parse(response.text);
				if (parsed.error && parsed.error.message) {
					errorMsg = parsed.error.message;
				}
			} catch (e) {
				// not json, stick with text
			}

			throw new Error(`Drive API Error ${response.status}: ${errorMsg}`);
		}
	}

	async getFolderId(folderName: string, parentId?: string): Promise<string | null> {
		let q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
		if (parentId) {
			q += ` and '${parentId}' in parents`;
		} else {
			q += ` and 'root' in parents`;
		}

		const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
		if (res.files && res.files.length > 0) {
			return res.files[0].id;
		}
		return null;
	}

	async createFolder(folderName: string, parentId?: string): Promise<string> {
		const metadata: any = {
			name: folderName,
			mimeType: 'application/vnd.google-apps.folder'
		};
		if (parentId) {
			metadata.parents = [parentId];
		}

		const res = await this.request('https://www.googleapis.com/drive/v3/files', 'POST', metadata);
		return res.id;
	}

	async ensureRootFolder(folderName: string): Promise<string> {
		let folderId = await this.getFolderId(folderName);
		if (!folderId) {
			folderId = await this.createFolder(folderName);
		}
		this.folderCache.clear(); // Reset cache for new sync
		return folderId;
	}

	async getOrCreateFolderTree(folderPath: string, rootFolderId: string): Promise<string> {
		if (!folderPath) return rootFolderId;

		if (this.folderCache.has(folderPath)) {
			return this.folderCache.get(folderPath)!;
		}

		const parts = folderPath.split('/');
		let currentParentId = rootFolderId;
		let currentPath = '';

		for (const part of parts) {
			currentPath += (currentPath === '' ? '' : '/') + part;
			if (this.folderCache.has(currentPath)) {
				currentParentId = this.folderCache.get(currentPath)!;
				continue;
			}

			let id = await this.getFolderId(part, currentParentId);
			if (!id) {
				id = await this.createFolder(part, currentParentId);
			}
			
			this.folderCache.set(currentPath, id);
			currentParentId = id;
		}

		return currentParentId;
	}

	async listAllVaultFiles(rootFolderId: string): Promise<DriveFile[]> {
		let files: DriveFile[] = [];
		let pageToken = '';

		// Query files that have our specific syncFolderId in their appProperties
		const q = `trashed=false and appProperties has { key='syncFolderId' and value='${rootFolderId}' }`;

		do {
			const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,description)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
			const res = await this.request(url);
			
			if (res.files) {
				for (const f of res.files) {
					if (f.description) {
						files.push({
							id: f.id,
							name: f.name,
							mimeType: f.mimeType,
							modifiedTime: f.modifiedTime,
							vaultPath: f.description
						});
					}
				}
			}
			pageToken = res.nextPageToken || '';
		} while (pageToken);

		return files;
	}

	async uploadFile(targetFolderId: string, name: string, vaultPath: string, rootFolderId: string, content: ArrayBuffer, existingId?: string, modifiedTime?: string): Promise<DriveFile> {
		const metadata: any = {
			name: name,
			description: vaultPath,
			appProperties: {
				syncFolderId: rootFolderId
			}
		};
		
		if (modifiedTime) {
			metadata.modifiedTime = modifiedTime;
		}

		if (!existingId) {
			metadata.parents = [targetFolderId];
		}

		const boundary = '-------314159265358979323846';
		const delimiter = `\r\n--${boundary}\r\n`;
		const close_delim = `\r\n--${boundary}--`;

		const metadataPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
		
		let base64Data = '';
		const bytes = new Uint8Array(content);
		const chunk = 8192;
		for (let i = 0; i < bytes.length; i += chunk) {
			base64Data += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
		}
		const base64Content = btoa(base64Data);

		const mediaPart = `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Content}`;
		const multipartRequestBody = `${delimiter}${metadataPart}${delimiter}${mediaPart}${close_delim}`;

		const url = existingId 
			? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,description`
			: `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,description`;

		const res = await this.request(url, existingId ? 'PATCH' : 'POST', multipartRequestBody, `multipart/related; boundary="${boundary}"`);
		
		return {
			id: res.id,
			name: res.name,
			mimeType: res.mimeType,
			modifiedTime: res.modifiedTime,
			vaultPath: res.description
		};
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		return await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, 'GET', undefined, undefined, 'arraybuffer') as ArrayBuffer;
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}`, 'DELETE');
	}
}
