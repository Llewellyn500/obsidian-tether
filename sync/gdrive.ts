import { requestUrl, RequestUrlParam } from 'obsidian';
import { OAuthManager, OAuthTokenResponse } from '../auth/oauth';
import { syncDiagnostics } from './diagnostics';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	createdTime?: string;
	modifiedTime: string;
	md5Checksum?: string;
	size?: string;
	parents?: string[];
	trashed?: boolean;
}

export interface DriveFilePage {
	files: DriveFile[];
	nextPageToken?: string;
}

export interface DriveDownloadChunk {
	content: ArrayBuffer;
	status: number;
}

const REQUEST_MIN_SPACING_MS = 35;
const REQUEST_MAX_SPACING_MS = 250;
const REQUEST_MAX_CONCURRENT = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 6;
const CHUNK_SIZE = 512 * 1024;
const CHUNK_THRESHOLD = 256 * 1024;
const DRIVE_FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,md5Checksum,size,parents,trashed';

export class SessionExpiredError extends Error {
	constructor(message = 'Session expired. Please log in again.') {
		super(message);
		this.name = 'SessionExpiredError';
	}
}

export class RequestTimeoutError extends Error {
	constructor(message = 'Google Drive request timed out.') {
		super(message);
		this.name = 'RequestTimeoutError';
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

class RequestQueue {
	private active = 0;
	private pending: Array<() => void> = [];
	private lastRequestAt = 0;
	private spacingMs = REQUEST_MIN_SPACING_MS;
	private paceTail: Promise<void> = Promise.resolve();

	schedule<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const start = () => {
				this.active++;
				void this.run(fn).then(resolve, reject).finally(() => {
					this.active--;
					this.pump();
				});
			};

			this.pending.push(start);
			this.pump();
		});
	}

	private pump() {
		while (this.active < REQUEST_MAX_CONCURRENT && this.pending.length > 0) {
			const next = this.pending.shift();
			if (next) next();
		}
	}

	private async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.pace();
		return fn();
	}

	private pace(): Promise<void> {
		this.paceTail = this.paceTail.then(async () => {
			const elapsed = Date.now() - this.lastRequestAt;
			const waitMs = Math.max(0, this.spacingMs - elapsed);
			if (waitMs > 0) {
				await sleep(waitMs);
			}
			this.lastRequestAt = Date.now();
		});
		return this.paceTail;
	}

	/** Speeds up after successful calls; slows down when Google rate-limits. */
	adaptAfterSuccess() {
		this.spacingMs = Math.max(REQUEST_MIN_SPACING_MS, Math.floor(this.spacingMs * 0.9));
	}

	adaptAfterRateLimit() {
		this.spacingMs = Math.min(REQUEST_MAX_SPACING_MS, Math.ceil(this.spacingMs * 1.75) + 20);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

export type UploadProgressCallback = (uploadedBytes: number, totalBytes: number) => void;

export class GoogleDriveClient {
	accessToken: string;
	onTokenRefresh?: (tokens: any) => Promise<void>;
	refreshParams?: { refreshToken: string, clientId: string, clientSecret: string };
	private refreshPromise?: Promise<void>;
	private requestQueue = new RequestQueue();
	private folderIdReservations: Map<string, Promise<string>>;

	constructor(
		accessToken: string,
		onTokenRefresh?: (tokens: any) => Promise<void>,
		refreshParams?: { refreshToken: string, clientId: string, clientSecret: string },
		folderIdReservations: Map<string, Promise<string>> = new Map()
	) {
		this.accessToken = accessToken;
		this.onTokenRefresh = onTokenRefresh;
		this.refreshParams = refreshParams;
		this.folderIdReservations = folderIdReservations;
	}

	private async request(options: RequestUrlParam, retryAuth = true): Promise<any> {
		return this.requestQueue.schedule(() => this.requestWithRetries(options, retryAuth));
	}

	private async requestWithRetries(options: RequestUrlParam, retryAuth: boolean): Promise<any> {
		let attempt = 0;

		while (true) {
			try {
				const response = await this.executeRequest(options, retryAuth);
				this.requestQueue.adaptAfterSuccess();
				return response;
			} catch (error) {
				if (error instanceof SessionExpiredError) throw error;
				if (error instanceof RequestTimeoutError) {
					if (attempt < MAX_RETRIES) {
						attempt++;
						const delayMs = this.getRetryDelayMs(attempt);
						syncDiagnostics.warn(`Request timed out, retrying in ${delayMs}ms`, undefined, undefined, 'timeout');
						await sleep(delayMs);
						continue;
					}
					throw new GoogleDriveApiError(0, 'Google Drive request timed out after multiple retries.', 'timeout', 'Check your network connection and try again.');
				}

				if (error instanceof GoogleDriveApiError && this.isRetryable(error.status, error.reason, error.message)) {
					if (this.isRateLimitError(error.status, error.reason, error.message)) {
						this.requestQueue.adaptAfterRateLimit();
					}
					if (attempt < MAX_RETRIES) {
						attempt++;
						const delayMs = this.getRetryDelayMs(attempt, error);
						syncDiagnostics.warn(
							`Drive API retry ${attempt}/${MAX_RETRIES} in ${delayMs}ms: ${error.message}`,
							undefined,
							error.status,
							error.reason
						);
						await sleep(delayMs);
						continue;
					}
				}

				throw error;
			}
		}
	}

	private async executeRequest(options: RequestUrlParam, retryAuth: boolean): Promise<any> {
		const requestOptions: RequestUrlParam = {
			...options,
			throw: false,
			headers: {
				...options.headers,
				'Authorization': `Bearer ${this.accessToken}`
			}
		};

		const timeoutMs = this.getTimeoutForRequest(options);
		let response;

		try {
			response = await this.requestWithTimeout(requestOptions, timeoutMs);
		} catch (error: unknown) {
			if (error instanceof RequestTimeoutError) throw error;
			const status = typeof error === 'object' && error !== null && 'status' in error
				? (error as { status?: number }).status
				: undefined;
			if (status === 401 && retryAuth && this.refreshParams && this.onTokenRefresh) {
				return await this.handleRefresh(options);
			}
			throw this.toApiError(error);
		}

		if (response.status === 401 && retryAuth && this.refreshParams && this.onTokenRefresh) {
			return await this.handleRefresh(options);
		}

		if (response.status === 308) {
			return response;
		}

		if (response.status >= 400) {
			throw this.toApiError(response);
		}

		return response;
	}

	private async requestWithTimeout(options: RequestUrlParam, timeoutMs: number): Promise<any> {
		let timeoutId: number | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = window.setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
		});

		try {
			return await Promise.race([requestUrl(options), timeoutPromise]);
		} finally {
			if (timeoutId !== undefined) {
				window.clearTimeout(timeoutId);
			}
		}
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

		if (status === 429 || this.isRateLimitError(status, reason, message)) {
			return 'Google Drive rate limit reached. Tether will retry automatically; large vaults may take longer to finish.';
		}

		if (status === 0 && normalizedReason === 'timeout') {
			return 'A Drive request timed out. Check your network connection and retry sync.';
		}

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

	private isRateLimitError(status: number, reason?: string, message?: string): boolean {
		if (status === 429) return true;
		if (status !== 403) return false;

		const normalizedReason = (reason || '').toLowerCase();
		const normalizedMessage = (message || '').toLowerCase();
		return normalizedReason.includes('ratelimit') ||
			normalizedReason.includes('userlimit') ||
			normalizedReason.includes('sharingratelimit') ||
			normalizedMessage.includes('rate limit') ||
			normalizedMessage.includes('quota');
	}

	private isRetryable(status: number, reason?: string, message?: string): boolean {
		return this.isRateLimitError(status, reason, message) || status >= 500;
	}

	private getRetryDelayMs(attempt: number, error?: GoogleDriveApiError): number {
		if (error?.status === 429 || this.isRateLimitError(error?.status || 0, error?.reason, error?.message)) {
			return Math.min(30_000, 2_000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
		}
		return Math.min(60_000, 1_000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
	}

	private getTimeoutForRequest(options: RequestUrlParam): number {
		const method = (options.method || 'GET').toUpperCase();
		if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
			return UPLOAD_REQUEST_TIMEOUT_MS;
		}
		return DEFAULT_REQUEST_TIMEOUT_MS;
	}

	private getContentLength(content: ArrayBuffer | string | Uint8Array): number {
		if (typeof content === 'string') {
			return new TextEncoder().encode(content).byteLength;
		}
		if (content instanceof Uint8Array) {
			return content.byteLength;
		}
		return content.byteLength;
	}

	private toByteArray(content: ArrayBuffer | string): Uint8Array {
		if (typeof content === 'string') {
			return new TextEncoder().encode(content);
		}
		return new Uint8Array(content);
	}

	/** Reuse the underlying buffer when possible to avoid doubling RAM on every upload. */
	private toRequestBody(bytes: Uint8Array): ArrayBuffer {
		if (
			bytes.byteOffset === 0 &&
			bytes.byteLength === bytes.buffer.byteLength &&
			bytes.buffer instanceof ArrayBuffer
		) {
			return bytes.buffer;
		}
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		return copy.buffer;
	}

	async listFiles(folderId: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.listFilesPage(folderId, pageToken);
			files.push(...page.files);
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

	async getFile(fileId: string): Promise<DriveFile> {
		const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS });
		const response = await this.request({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
			method: 'GET'
		});
		return response.json;
	}

	async downloadFileRange(fileId: string, start: number, end: number): Promise<DriveDownloadChunk> {
		const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
		const response = await this.request({
			url,
			method: 'GET',
			headers: { 'Range': `bytes=${start}-${end}` }
		});
		return { content: response.arrayBuffer, status: response.status };
	}

	async listFolders(parentId: string = 'root'): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.listFoldersPage(parentId, pageToken);
			files.push(...page.files);
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
			fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
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
		const reservationKey = JSON.stringify([parentId || '', name.toLowerCase()]);
		const reservation = this.reserveFolderId(reservationKey);
		const id = await reservation;
		const metadata = {
			id,
			name,
			mimeType: 'application/vnd.google-apps.folder',
			parents: parentId ? [parentId] : []
		};
		const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS });

		try {
			const response = await this.request({
				url: `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(metadata)
			});
			this.releaseFolderId(reservationKey, reservation);
			return response.json;
		} catch (error) {
			const shouldReconcile = error instanceof GoogleDriveApiError &&
				(error.status === 409 || error.status === 0 || this.isRetryable(error.status, error.reason, error.message));
			if (!shouldReconcile) throw error;

			let existing: DriveFile;
			try {
				existing = await this.getFile(id);
			} catch {
				// Keep this ID reserved: a timed-out create can still finish after this call returns.
				throw error;
			}
			const hasExpectedParent = !parentId || existing.parents?.includes(parentId) === true;
			if (existing.trashed ||
				existing.mimeType !== 'application/vnd.google-apps.folder' ||
				existing.name.toLowerCase() !== name.toLowerCase() ||
				!hasExpectedParent) {
				throw error;
			}
			this.releaseFolderId(reservationKey, reservation);
			return existing;
		}
	}

	private reserveFolderId(key: string): Promise<string> {
		const existing = this.folderIdReservations.get(key);
		if (existing) return existing;

		const reservation = this.generateFileId().catch(error => {
			this.releaseFolderId(key, reservation);
			throw error;
		});
		this.folderIdReservations.set(key, reservation);
		return reservation;
	}

	private releaseFolderId(key: string, reservation: Promise<string>) {
		if (this.folderIdReservations.get(key) === reservation) {
			this.folderIdReservations.delete(key);
		}
	}

	private async generateFileId(): Promise<string> {
		const params = new URLSearchParams({ count: '1', space: 'drive', type: 'files' });
		const response = await this.request({
			url: `https://www.googleapis.com/drive/v3/files/generateIds?${params.toString()}`,
			method: 'GET'
		});
		const id = response.json.ids?.[0];
		if (!id) throw new Error('Google Drive did not return a generated file ID.');
		return id;
	}

	async moveFile(fileId: string, fromParentId: string, toParentId: string, name?: string): Promise<DriveFile> {
		const params = new URLSearchParams({
			addParents: toParentId,
			removeParents: fromParentId,
			fields: DRIVE_FILE_FIELDS
		});
		const response = await this.request({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(name ? { name } : {})
		});
		return response.json;
	}

	async renameFile(fileId: string, name: string): Promise<DriveFile> {
		const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS });
		const response = await this.request({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		return response.json;
	}

	async uploadFile(name: string, folderId: string, content: ArrayBuffer | string, mimeType = 'text/markdown', onProgress?: UploadProgressCallback): Promise<DriveFile> {
		const metadata = {
			name,
			parents: [folderId],
			mimeType
		};
		const contentLength = this.getContentLength(content);

		const initUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,md5Checksum,size';
		const initResponse = await this.request({
			url: initUrl,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': mimeType,
				'X-Upload-Content-Length': String(contentLength),
			},
			body: JSON.stringify(metadata)
		});

		const uploadUrl = initResponse.headers['location'] || initResponse.headers['Location'];
		if (!uploadUrl) throw new Error('Failed to get resumable upload URL');

		return this.uploadResumableContent(uploadUrl, content, mimeType, onProgress);
	}

	async updateFile(fileId: string, content: ArrayBuffer | string, mimeType = 'text/markdown', onProgress?: UploadProgressCallback): Promise<DriveFile> {
		const contentLength = this.getContentLength(content);
		const initUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,md5Checksum,size`;
		const initResponse = await this.request({
			url: initUrl,
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': mimeType,
				'X-Upload-Content-Length': String(contentLength),
			},
			body: JSON.stringify({})
		});

		const uploadUrl = initResponse.headers['location'] || initResponse.headers['Location'];
		if (!uploadUrl) throw new Error('Failed to get resumable update URL');

		return this.uploadResumableContent(uploadUrl, content, mimeType, onProgress);
	}

	private async uploadResumableContent(uploadUrl: string, content: ArrayBuffer | string, mimeType: string, onProgress?: UploadProgressCallback): Promise<DriveFile> {
		const total = this.getContentLength(content);
		onProgress?.(0, total);

		// Do not set Content-Length: Obsidian/Chromium requestUrl rejects it with net::ERR_INVALID_ARGUMENT.
		if (total <= CHUNK_THRESHOLD) {
			const body = typeof content === 'string'
				? this.toRequestBody(this.toByteArray(content))
				: content;
			const uploadResponse = await this.request({
				url: uploadUrl,
				method: 'PUT',
				headers: {
					'Content-Type': mimeType,
				},
				body
			});
			onProgress?.(total, total);
			return uploadResponse.json;
		}

		// Large files: keep one Uint8Array view (no full copy), copy only each chunk for the request.
		const bytes = this.toByteArray(content);
		let offset = 0;
		while (offset < total) {
			const end = Math.min(offset + CHUNK_SIZE, total);
			const chunk = bytes.subarray(offset, end);
			const isLast = end === total;
			const headers: Record<string, string> = {
				'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
			};

			if (isLast) {
				headers['Content-Type'] = mimeType;
			}

			onProgress?.(offset, total);

			const uploadResponse = await this.request({
				url: uploadUrl,
				method: 'PUT',
				headers,
				body: this.toRequestBody(chunk)
			});

			offset = end;
			onProgress?.(offset, total);

			if (isLast) {
				return uploadResponse.json;
			}

			if (uploadResponse.status !== 308) {
				throw new Error(`Unexpected resumable upload response: ${uploadResponse.status}`);
			}
		}

		throw new Error('Resumable upload completed without final response.');
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

	async trashFile(fileId: string): Promise<void> {
		const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
		await this.request({
			url,
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trashed: true })
		});
	}
}
