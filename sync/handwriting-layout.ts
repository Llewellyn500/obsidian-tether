import { MarkdownView, Plugin, normalizePath } from 'obsidian';

export interface HandwritingLayout { width: number; fontPx: number }

// Keep one wrap for the whole page. Handwriting refuses line anchors under a
// different width/font; choosing a different layout per stroke cannot fix that.
export function handwritingLayout(data: unknown): HandwritingLayout | null {
	const page = data as { surface?: string; strokes?: any[] } | null;
	if (!page || page.surface !== 'inline' || !Array.isArray(page.strokes)) return null;
	const groups = new Map<string, { layout: HandwritingLayout; count: number }>();
	for (const stroke of page.strokes) {
		const a = stroke?.lineAnchor;
		if (!a || !Number.isFinite(a.width) || a.width < 100 || a.width > 10000 ||
			!Number.isFinite(a.fontPx) || a.fontPx < 6 || a.fontPx > 100) continue;
		const layout = { width: a.width, fontPx: a.fontPx };
		const key = `${layout.width}:${layout.fontPx}`;
		const group = groups.get(key);
		if (group) group.count++;
		else groups.set(key, { layout, count: 1 });
	}
	return [...groups.values()].sort((a, b) => b.count - a.count)[0]?.layout ?? null;
}

export class HandwritingLayoutSupport {
	private running = false;
	private disposed = false;
	private styles = new Map<HTMLElement, { style: HTMLStyleElement; key: string }>();
	private nextId = 0;
	constructor(private plugin: Plugin) {}

	start() {
		this.plugin.app.workspace.onLayoutReady(() => { void this.refresh(); });
		this.plugin.registerEvent(this.plugin.app.workspace.on('layout-change', () => { void this.refresh(); }));
		this.plugin.registerEvent(this.plugin.app.workspace.on('file-open', () => { void this.refresh(); }));
		// Hidden sidecars are written through the adapter, without Vault modify events.
		this.plugin.registerInterval(window.setInterval(() => { void this.refresh(); }, 2000));
		this.plugin.register(() => {
			this.disposed = true;
			for (const [el, entry] of this.styles) {
				entry.style.remove();
				el.removeAttribute('data-tether-handwriting');
			}
			this.styles.clear();
		});
	}

	async refresh() {
		if (this.running || this.disposed) return;
		this.running = true;
		try {
			const { app } = this.plugin;
			const live = new Set<HTMLElement>();
			for (const leaf of app.workspace.getLeavesOfType('markdown')) {
				if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) continue;
				const view = leaf.view;
				const file = view.file;
				const el = view.contentEl;
				live.add(el);
				const pageId = app.metadataCache.getFileCache(file)?.frontmatter?.['handwriting-page-id'];
				if (typeof pageId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(pageId)) {
					this.clear(el);
					continue;
				}
				let layout: HandwritingLayout | null = null;
				try {
					const settings = JSON.parse(await app.vault.adapter.read(normalizePath(`${app.vault.configDir || '.obsidian'}/plugins/handwriting/data.json`)).catch(() => '{}'));
					const folder = typeof settings.inkFolder === 'string' ? settings.inkFolder : '.handwriting';
					if (folder.split(/[\\/]/).includes('..') || folder.startsWith('/') || folder.includes(':')) continue;
					const page = JSON.parse(await app.vault.adapter.read(normalizePath(`${folder}/${pageId}.json`)));
					layout = handwritingLayout(page);
				} catch {
					// A sidecar can be temporarily absent during a pull or an atomic ink save.
					continue;
				}
				if (this.disposed) return;
				if (view.file !== file) continue;
				if (!layout) { this.clear(el); continue; }
				const key = `${file.path}:${layout.width}:${layout.fontPx}`;
				if (this.styles.get(el)?.key === key) continue;
				this.clear(el);
				const id = `ink-${++this.nextId}`;
				el.setAttribute('data-tether-handwriting', id);
				const style = el.ownerDocument.createElement('style');
				const selector = `[data-tether-handwriting="${id}"]`;
				style.textContent = `
${selector} .markdown-source-view {
 --file-line-width: ${layout.width}px;
 --font-text-size: ${layout.fontPx}px;
 font-size: ${layout.fontPx}px !important;
}
${selector} .cm-content {
 width: ${layout.width}px !important;
 min-width: ${layout.width}px !important;
 max-width: ${layout.width}px !important;
}
${selector} .cm-content { font-size: ${layout.fontPx}px !important; }
`;
				el.ownerDocument.head.appendChild(style);
				this.styles.set(el, { style, key });
			}
			for (const el of this.styles.keys()) if (!live.has(el)) this.clear(el);
		} catch (error) {
			console.warn('Tether: could not refresh handwriting layout', error);
		} finally { this.running = false; }
	}

	private clear(el: HTMLElement) {
		this.styles.get(el)?.style.remove();
		this.styles.delete(el);
		el.removeAttribute('data-tether-handwriting');
	}
}
