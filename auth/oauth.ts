import { requestUrl } from 'obsidian';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email';
const REDIRECT_URI = 'https://llewellyn500.github.io/obsidian-tether/oauth/callback.html';

export interface OAuthTokenResponse {
	access_token: string;
	expires_in?: number;
	refresh_token?: string;
	refresh_token_expires_in?: number;
	scope?: string;
	token_type?: string;
}

export class OAuthTokenError extends Error {
	code?: string;
	status?: number;

	constructor(message: string, code?: string, status?: number) {
		super(message);
		this.name = 'OAuthTokenError';
		this.code = code;
		this.status = status;
	}
}

export class OAuthManager {
	static async generateCodeVerifier() {
		const array = new Uint8Array(32);
		window.crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	static async generateCodeChallenge(verifier: string) {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const digest = await window.crypto.subtle.digest('SHA-256', data);
		return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	static async getAuthUrl(clientId: string, codeChallenge: string, state: string) {
		const params = new URLSearchParams({
			client_id: clientId.trim(),
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: SCOPES,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			prompt: 'consent',
			state
		});

		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	static async exchangeCodeForToken(code: string, codeVerifier: string, clientId: string, clientSecret: string): Promise<OAuthTokenResponse> {
		return this.requestToken(new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code: code,
			code_verifier: codeVerifier,
			redirect_uri: REDIRECT_URI,
			grant_type: 'authorization_code'
		}));
	}

	static async refreshToken(refreshToken: string, clientId: string, clientSecret: string): Promise<OAuthTokenResponse> {
		if (!refreshToken.trim()) {
			throw new OAuthTokenError('No refresh token is saved. Please log in again.', 'missing_refresh_token');
		}

		return this.requestToken(new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		}));
	}

	static isExpiredOrRevoked(error: unknown): boolean {
		const code = typeof error === 'object' && error !== null && 'code' in error
			? String((error as { code?: string }).code || '').toLowerCase()
			: '';
		const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

		return code === 'invalid_grant' ||
			code === 'missing_refresh_token' ||
			message.includes('invalid_grant') ||
			message.includes('expired or revoked') ||
			message.includes('token has been expired') ||
			message.includes('token has been revoked') ||
			message.includes('no refresh token');
	}

	private static async requestToken(body: URLSearchParams): Promise<OAuthTokenResponse> {
		let response;
		try {
			response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
				throw: false
			});
		} catch (error) {
			throw this.toTokenError(error);
		}

		const json = response.json || this.parseJson(response.text);
		if (response.status >= 400 || json?.error) {
			throw this.toTokenError({
				status: response.status,
				json,
				text: response.text
			});
		}

		if (!json?.access_token) {
			throw new OAuthTokenError('Google did not return an access token.');
		}

		return json as OAuthTokenResponse;
	}

	private static toTokenError(error: unknown): OAuthTokenError {
		if (error instanceof OAuthTokenError) {
			return error;
		}

		const errorObj = typeof error === 'object' && error !== null ? error as Record<string, any> : {};
		const status = typeof errorObj.status === 'number' ? errorObj.status : undefined;
		const json = errorObj.json || this.parseJson(typeof errorObj.text === 'string' ? errorObj.text : '');
		const code = typeof json?.error === 'string' ? json.error : undefined;
		const description = typeof json?.error_description === 'string' ? json.error_description : undefined;
		const fallback = error instanceof Error ? error.message : String(error);

		if (code === 'redirect_uri_mismatch') {
			return new OAuthTokenError(
				`Redirect URI mismatch. In Google Cloud Console → Credentials → your OAuth client, add this exact Authorized redirect URI: ${REDIRECT_URI}`,
				code,
				status
			);
		}

		return new OAuthTokenError(description || code || fallback, code, status);
	}

	private static parseJson(text?: string): any {
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (e) {
			return null;
		}
	}
}
