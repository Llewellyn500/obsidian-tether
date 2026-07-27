import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));
const outputDir = await mkdtemp(join(tmpdir(), 'tether-tests-'));
const outfile = join(outputDir, 'sync-engine.test.cjs');

const obsidianStub = {
	name: 'obsidian-stub',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({
			path: 'obsidian',
			namespace: 'obsidian-stub'
		}));
		builder.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
			loader: 'ts',
			contents: `
				export class Notice { constructor(_message?: string) {} }
				export class ItemView {
					containerEl: any = {};
					constructor(_leaf?: any) {}
				}
				export class TFile {}
				export const normalizePath = (path: string) => path.replace(/\\\\/g, '/');
				export const requestUrl = async () => { throw new Error('Unexpected live request in test.'); };
			`
		}));
	}
};

try {
	await build({
		entryPoints: [join(testDir, 'sync-engine.test.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		outfile,
		plugins: [obsidianStub],
		logLevel: 'silent'
	});

	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', code => resolve(code ?? 1));
	});
	process.exitCode = exitCode;
} finally {
	await rm(outputDir, { recursive: true, force: true });
}
