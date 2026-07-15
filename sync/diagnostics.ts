import type { SyncStats } from '../ui/sync-view';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
	timestamp: number;
	level: DiagnosticLevel;
	mode?: string;
	path?: string;
	message: string;
	status?: number;
	reason?: string;
}

const MAX_EVENTS = 200;

export class SyncDiagnostics {
	private events: DiagnosticEvent[] = [];
	private currentMode = '';

	startSession(mode: string) {
		this.currentMode = mode;
		this.info(`Sync session started (${mode})`);
	}

	endSession(status: string, stats?: Partial<SyncStats>) {
		const summary = stats
			? `${status}: ${stats.processed ?? 0}/${stats.totalFiles ?? 0} processed, ${stats.failed ?? 0} failed`
			: status;
		this.info(`Sync session ended (${summary})`);
		this.currentMode = '';
	}

	info(message: string, path?: string) {
		this.add('info', message, path);
	}

	warn(message: string, path?: string, status?: number, reason?: string) {
		this.add('warn', message, path, status, reason);
	}

	error(message: string, path?: string, status?: number, reason?: string) {
		this.add('error', message, path, status, reason);
	}

	getEvents(): DiagnosticEvent[] {
		return [...this.events];
	}

	formatReport(pluginVersion: string, stats?: SyncStats): string {
		const lines: string[] = [
			'Tether Sync Diagnostics',
			'=======================',
			`Generated: ${new Date().toISOString()}`,
			`Plugin version: ${pluginVersion}`,
		];

		if (stats) {
			lines.push(
				`Status: ${stats.status}`,
				`Progress: ${stats.processed}/${stats.totalFiles}`,
				`Failed: ${stats.failed}`,
				`Deferred: ${stats.deferred.length}`,
				`Last sync: ${stats.lastSync || 'n/a'}`,
			);
			if (stats.currentFile) {
				lines.push(`Current/last file: ${stats.currentFile}`);
			}
			if (stats.errors.length > 0) {
				lines.push('', 'Recent sync errors:');
				for (const err of stats.errors.slice(-20)) {
					lines.push(`  - ${err.path}: ${err.message}`);
				}
			}
		}

		lines.push('', 'Event log:');
		for (const event of this.events) {
			const time = new Date(event.timestamp).toISOString();
			const mode = event.mode ? ` [${event.mode}]` : '';
			const path = event.path ? ` (${event.path})` : '';
			const http = event.status ? ` HTTP ${event.status}` : '';
			const reason = event.reason ? ` (${event.reason})` : '';
			lines.push(`${time} ${event.level.toUpperCase()}${mode}${path}: ${event.message}${http}${reason}`);
		}

		return lines.join('\n');
	}

	private add(level: DiagnosticLevel, message: string, path?: string, status?: number, reason?: string) {
		this.events.push({
			timestamp: Date.now(),
			level,
			mode: this.currentMode || undefined,
			path,
			message: this.sanitize(message),
			status,
			reason,
		});

		if (this.events.length > MAX_EVENTS) {
			this.events.splice(0, this.events.length - MAX_EVENTS);
		}
	}

	private sanitize(message: string): string {
		return message
			.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
			.replace(/access_token[=:]\s*["']?[^"'\s]+/gi, 'access_token=[redacted]')
			.replace(/refresh_token[=:]\s*["']?[^"'\s]+/gi, 'refresh_token=[redacted]')
			.replace(/client_secret[=:]\s*["']?[^"'\s]+/gi, 'client_secret=[redacted]');
	}
}

export const syncDiagnostics = new SyncDiagnostics();
