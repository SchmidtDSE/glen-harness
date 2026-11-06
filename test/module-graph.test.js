import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module reachable through static imports and re-exports, not import(). */
function staticGraph(entry) {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/gms)) {
            visit(resolve(dirname(file), m[1]));
        }
    };
    visit(resolve(root, entry));
    return [...seen].map((f) => f.slice(root.length + 1));
}

describe('what each entry loads up front', () => {
    it('the chat loads the export report only when it runs', () => {
        const graph = staticGraph('ui/chat-ui.js');
        expect(graph).not.toContain('ui/export-report.js');
        expect(graph).toEqual(expect.arrayContaining(['ui/markdown.js', 'ui/export-config.js']));
        expect(readFileSync(resolve(root, 'ui/chat-ui.js'), 'utf8')).toContain("import('./export-report.js')");
    });

    it('the core entry reaches no MCP code', () => {
        const graph = staticGraph('src/core.js');
        expect(graph.some((f) => /mcp|vendor/.test(f))).toBe(false);
        expect(graph).toEqual(expect.arrayContaining(['src/agent.js', 'src/tool-registry.js']));
    });

    it('the core entry and the chat together are the files a map-only app needs', () => {
        const files = new Set([...staticGraph('src/core.js'), ...staticGraph('ui/chat-ui.js')]);
        expect([...files].sort()).toEqual([
            'src/agent.js', 'src/core.js', 'src/tool-registry.js',
            'ui/chat-ui.js', 'ui/export-config.js', 'ui/icons.js', 'ui/markdown.js',
        ]);
    });
});
