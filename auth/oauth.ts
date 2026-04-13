import { requestUrl } from 'obsidian';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email';
const REDIRECT_URI = 'https://obsidian.md'; 

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

	static async getAuthUrl(clientId: string, codeChallenge: string) {
		return `https://accounts.google.com/o/oauth2/v2/auth?` + 
			`client_id=${clientId}&` +
			`redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
			`response_type=code&` +
			`scope=${encodeURIComponent(SCOPES)}&` +
			`code_challenge=${codeChallenge}&` +
			`code_challenge_method=S256&` +
			`access_type=offline&` +
			`prompt=consent`;
	}

	static async exchangeCodeForToken(code: string, codeVerifier: string, clientId: string, clientSecret: string) {
		const response = await requestUrl({
			url: 'https://oauth2.googleapis.com/token',
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code: code,
				code_verifier: codeVerifier,
				redirect_uri: REDIRECT_URI,
				grant_type: 'authorization_code'
			}).toString()
		});
		return response.json;
	}

	static async refreshToken(refreshToken: string, clientId: string, clientSecret: string) {
		const response = await requestUrl({
			url: 'https://oauth2.googleapis.com/token',
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: 'refresh_token'
			}).toString()
		});
		return response.json;
	}
}
