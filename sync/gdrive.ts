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

export class GoogleDriveApiError extends Error {
	status: number;
	reason?: string;
	hint?: string;

	constructor(status: number, message: string, reason?: string, hint?: string) {
		super(message);
		this.name = 'GoogleDriveApiError';
		this.status = status;
		this.reason = reason;
		this.hint = hint;
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
		const requestOptions: RequestUrlParam = {
			...options,
			throw: false,
			headers: {
				...options.headers,
				'Authorization': `Bearer ${this.accessToken}`
			}
		};
		
		let response;
		try {
			response = await requestUrl(requestOptions);
		} catch (error: unknown) {
			const status = typeof error === 'object' && error !== null && 'status' in error
				? (error as { status?: number }).status
				: undefined;
			if (status === 401 && retry && this.refreshParams && this.onTokenRefresh) {
				return await this.handleRefresh(options);
			}
			throw this.toApiError(error);
		}
		
		if (response.status === 401 && retry && this.refreshParams && this.onTokenRefresh) {
			return await this.handleRefresh(options);
		}

		if (response.status >= 400) {
			throw this.toApiError(response);
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

	private toApiError(errorOrResponse: unknown): GoogleDriveApiError {
		const input = typeof errorOrResponse === 'object' && errorOrResponse !== null
			? errorOrResponse as Record<string, any>
			: {};
		const status = typeof input.status === 'number' ? input.status : 0;
		const text = typeof input.text === 'string' ? input.text : '';
		const json = input.json || this.parseJson(text);
		const googleError = json?.error;
		const detail = Array.isArray(googleError?.errors) ? googleError.errors[0] : undefined;
		const reason = detail?.reason || googleError?.status || googleError?.code;
		const message = googleError?.message ||
			detail?.message ||
			(errorOrResponse instanceof Error ? errorOrResponse.message : '') ||
			text ||
			`Request failed, status ${status || 'unknown'}`;
		const hint = this.getApiErrorHint(status, reason, message);

		return new GoogleDriveApiError(status, `Google Drive API Error: ${message}`, reason, hint);
	}

	private parseJson(text: string): any {
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (e) {
			return null;
		}
	}

	private getApiErrorHint(status: number, reason: string | undefined, message: string): string | undefined {
		const normalizedReason = (reason || '').toLowerCase();
		const normalizedMessage = message.toLowerCase();

		if (status === 403 && (
			normalizedReason.includes('accessnotconfigured') ||
			normalizedMessage.includes('api has not been used') ||
			normalizedMessage.includes('it is disabled')
		)) {
			return 'Enable the Google Drive API in the same Google Cloud project used for this OAuth client, then wait a few minutes and try again.';
		}

		if (status === 403 && (
			normalizedReason.includes('insufficientpermissions') ||
			normalizedMessage.includes('insufficient authentication scopes') ||
			normalizedMessage.includes('insufficient permission')
		)) {
			return 'Add the required Drive scopes in Google Cloud Data Access, then log out of Tether and log in again so Google grants a new token.';
		}

		if (status === 403) {
			return 'Check that the Drive API is enabled, the required Drive scopes are added, this Google account is allowed to test the app if it is still in Testing, and then log in to Tether again.';
		}

		return undefined;
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
