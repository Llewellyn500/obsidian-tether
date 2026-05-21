import { requestUrl, RequestUrlParam } from 'obsidian';
import { OAuthManager, OAuthTokenResponse } from '../auth/oauth';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	md5Checksum?: string;
	size?: string;
}

export interface DriveFilePage {
	files: DriveFile[];
	nextPageToken?: string;
}

export class SessionExpiredError extends Error {
	constructor(message = 'Session expired. Please log in again.') {
		super(message);
		this.name = 'SessionExpiredError';
	}
}

export function isSessionExpiredError(error: unknown): boolean {
	return error instanceof SessionExpiredError ||
		(error instanceof Error && error.name === 'SessionExpiredError');
}

export class GoogleDriveClient {
	accessToken: string;
	onTokenRefresh?: (tokens: any) => Promise<void>;
	refreshParams?: { refreshToken: string, clientId: string, clientSecret: string };
	private refreshPromise?: Promise<void>;

	constructor(accessToken: string, onTokenRefresh?: (tokens: any) => Promise<void>, refreshParams?: { refreshToken: string, clientId: string, clientSecret: string }) {
		this.accessToken = accessToken;
		this.onTokenRefresh = onTokenRefresh;
		this.refreshParams = refreshParams;
	}

	private async request(options: RequestUrlParam, retry: boolean = true): Promise<any> {
		options.headers = {
			...options.headers,
			'Authorization': `Bearer ${this.accessToken}`
		};
		
		let response;
		try {
			response = await requestUrl(options);
		} catch (error: unknown) {
			const status = typeof error === 'object' && error !== null && 'status' in error
				? (error as { status?: number }).status
				: undefined;
			if (status === 401 && retry && this.refreshParams && this.onTokenRefresh) {
				return await this.handleRefresh(options);
			}
			throw error;
		}
		
		if (response.status === 401 && retry && this.refreshParams && this.onTokenRefresh) {
			return await this.handleRefresh(options);
		}

		if (response.status >= 400) {
			let message = response.text || `Status ${response.status}`;
			try {
				const json = JSON.parse(response.text);
				if (json.error && json.error.message) {
					message = json.error.message;
				}
			} catch (e) {
				// Not JSON or missing message
			}
			const error: any = new Error(`Google Drive API Error: ${message}`);
			error.status = response.status;
			throw error;
		}
		return response;
	}

	private async handleRefresh(options: RequestUrlParam): Promise<any> {
		await this.refreshAccessToken();
		return this.request(options, false);
	}

	async refreshAccessToken(): Promise<void> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = this.performTokenRefresh()
			.finally(() => {
				this.refreshPromise = undefined;
			});

		return this.refreshPromise;
	}

	private async performTokenRefresh(): Promise<void> {
		console.log('Access token expired. Attempting refresh...');
		if (!this.refreshParams) {
			throw new SessionExpiredError();
		}

		let tokens: OAuthTokenResponse;
		try {
			tokens = await OAuthManager.refreshToken(
				this.refreshParams.refreshToken,
				this.refreshParams.clientId,
				this.refreshParams.clientSecret
			);
		} catch (refreshError) {
			console.error('Token refresh failed', refreshError);
			if (OAuthManager.isExpiredOrRevoked(refreshError)) {
				throw new SessionExpiredError();
			}
			throw refreshError;
		}

		this.applyTokenResponse(tokens);
		if (this.onTokenRefresh) {
			await this.onTokenRefresh(tokens);
		}
	}

	private applyTokenResponse(tokens: OAuthTokenResponse) {
		this.accessToken = tokens.access_token;
		if (tokens.refresh_token && this.refreshParams) {
			this.refreshParams.refreshToken = tokens.refresh_token;
		}
	}

	async listFiles(folderId: string): Promise<DriveFile[]> {
		let files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.listFilesPage(folderId, pageToken);
			files = files.concat(page.files);
			pageToken = page.nextPageToken;
		} while (pageToken);
		return files;
	}

	async listFilesPage(folderId: string, pageToken?: string): Promise<DriveFilePage> {
		return this.listChildrenPage(folderId, false, pageToken);
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
		const response = await this.request({ url, method: 'GET' });
		return response.arrayBuffer;
	}

	async listFolders(parentId: string = 'root'): Promise<DriveFile[]> {
		let files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.listFoldersPage(parentId, pageToken);
			files = files.concat(page.files);
			pageToken = page.nextPageToken;
		} while (pageToken);
		return files;
	}

	async listFoldersPage(parentId: string = 'root', pageToken?: string): Promise<DriveFilePage> {
		return this.listChildrenPage(parentId, true, pageToken);
	}

	private async listChildrenPage(parentId: string, foldersOnly: boolean, pageToken?: string): Promise<DriveFilePage> {
		const folderMimeType = 'application/vnd.google-apps.folder';
		const qParts = [`'${parentId}' in parents`, 'trashed = false'];
		if (foldersOnly) {
			qParts.push(`mimeType = '${folderMimeType}'`);
		}

		const params = new URLSearchParams({
			q: qParts.join(' and '),
			fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
			pageSize: '100',
			corpora: 'user',
			spaces: 'drive'
		});

		if (pageToken) {
			params.set('pageToken', pageToken);
		}

		const response = await this.request({
			url: `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
			method: 'GET'
		});

		return {
			files: response.json.files || [],
			nextPageToken: response.json.nextPageToken
		};
	}

	async createFolder(name: string, parentId?: string): Promise<DriveFile> {
		const metadata = {
			name,
			mimeType: 'application/vnd.google-apps.folder',
			parents: parentId ? [parentId] : []
		};
		const url = 'https://www.googleapis.com/drive/v3/files';
		const response = await this.request({
			url,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(metadata)
		});
		return response.json;
	}

	async uploadFile(name: string, folderId: string, content: ArrayBuffer | string, mimeType = 'text/markdown'): Promise<DriveFile> {
		const metadata = {
			name,
			parents: [folderId],
			mimeType
		};

		const initUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,md5Checksum,size';
		const initResponse = await this.request({
			url: initUrl,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': mimeType,
			},
			body: JSON.stringify(metadata)
		});

		const uploadUrl = initResponse.headers['location'] || initResponse.headers['Location'];
		if (!uploadUrl) throw new Error('Failed to get resumable upload URL');

		const uploadResponse = await this.request({
			url: uploadUrl,
			method: 'PUT',
			headers: {
				'Content-Type': mimeType
			},
			body: content
		});

		return uploadResponse.json;
	}

	async updateFile(fileId: string, content: ArrayBuffer | string, mimeType = 'text/markdown'): Promise<DriveFile> {
		const initUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,md5Checksum,size`;
		const initResponse = await this.request({
			url: initUrl,
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': mimeType,
			},
			body: JSON.stringify({})
		});

		const uploadUrl = initResponse.headers['location'] || initResponse.headers['Location'];
		if (!uploadUrl) throw new Error('Failed to get resumable update URL');

		const uploadResponse = await this.request({
			url: uploadUrl,
			method: 'PUT',
			headers: {
				'Content-Type': mimeType
			},
			body: content
		});

		return uploadResponse.json;
	}

	async getUserInfo(): Promise<{ email: string }> {
		const response = await this.request({
			url: 'https://www.googleapis.com/oauth2/v3/userinfo',
			method: 'GET'
		});
		return response.json;
	}

	async deleteFile(fileId: string): Promise<void> {
		const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
		await this.request({ url, method: 'DELETE' });
	}
}
