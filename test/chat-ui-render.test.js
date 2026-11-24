// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderMarkdown, ChatUI } from '../ui/chat-ui.js';

// chat-ui.js consumes marked and DOMPurify as page globals (CDN script
// tags); mirror that here with the real libraries.
beforeAll(() => {
    globalThis.marked = marked;
    globalThis.DOMPurify = DOMPurify;
});

afterEach(() => {
    globalThis.marked = marked;
    globalThis.DOMPurify = DOMPurify;
});

const render = (md) => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(md);
    return el;
};

describe('renderMarkdown sanitization', () => {
    it('strips event-handler XSS that marked passes through', () => {
        const el = render('Here is the result: <img src=x onerror="window.__pwned=1">');
        expect(el.querySelector('img[onerror]')).toBeNull();
        expect(renderMarkdown('x <img src=x onerror=alert(1)>')).not.toContain('onerror');
    });

    it('strips script tags', () => {
        expect(renderMarkdown('hello <script>alert(1)</script> world')).not.toContain('<script');
    });

    it('strips javascript: URLs in links', () => {
        const el = render('[click me](javascript:alert(1))');
        const a = el.querySelector('a');
        if (a) expect(a.getAttribute('href') || '').not.toMatch(/^javascript:/i);
    });

    it('preserves markdown tables', () => {
        const el = render('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(el.querySelector('table')).not.toBeNull();
        expect(el.querySelectorAll('td')).toHaveLength(2);
    });

    it('preserves fenced code blocks with language class (hljs hook)', () => {
        const el = render('```sql\nSELECT 1;\n```');
        const code = el.querySelector('pre code');
        expect(code).not.toBeNull();
        expect(code.className).toContain('language-sql');
        expect(code.textContent).toContain('SELECT 1;');
    });

    it('preserves ordinary links', () => {
        const el = render('[docs](https://example.com/page)');
        expect(el.querySelector('a[href="https://example.com/page"]')).not.toBeNull();
    });

    it('scrubs credential-shaped tokens before rendering (SEC-4)', () => {
        const out = renderMarkdown("Run: CREATE SECRET (KEY_ID 'AKIAXXXX', SECRET 'shhh-very-secret');");
        expect(out).not.toContain('AKIAXXXX');
        expect(out).not.toContain('shhh-very-secret');
        expect(out).toContain('[REDACTED]');
    });

    it('fails closed (escaped text, no raw HTML) when DOMPurify is missing', () => {
        delete globalThis.DOMPurify;
        const el = render('**bold** <img src=x onerror=alert(1)>');
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img');
    });

    it('fails closed when marked is missing', () => {
        delete globalThis.marked;
        const el = render('<img src=x onerror=alert(1)>');
        expect(el.querySelector('img')).toBeNull();
    });
});

/**
 * Tool-call names come from the LLM response JSON (structured tool_calls),
 * which prompt injection can steer — they must be escaped like every other
 * value in the tool rows.
 */
describe('tool-call name escaping', () => {
    it('escapes HTML in proposed tool-call names (renderToolCallArgs)', () => {
        const ui = Object.create(ChatUI.prototype);
        const html = ui.renderToolCallArgs({
            function: { name: '<img src=x onerror=alert(1)>', arguments: '{}' },
        });
        const el = document.createElement('div');
        el.innerHTML = html;
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img');
    });

    it('escapes HTML in result names (showToolResults)', () => {
        const ui = Object.create(ChatUI.prototype);
        const row = document.createElement('details');
        row.innerHTML = '<summary><span class="row-status running"></span></summary>' +
            '<div class="agent-turn-row-body"></div>';
        ui.currentTurn = { rowsByIter: new Map([[1, row]]) };
        ui.scrollToBottom = () => {};
        ui.showToolResults(
            [{ name: '<img src=x onerror=alert(1)>', success: true, result: 'ok' }],
            1
        );
        const body = row.querySelector('.agent-turn-row-body');
        expect(body.querySelector('img')).toBeNull();
        expect(body.textContent).toContain('<img');
    });
});

describe('result actions (addResultAction)', () => {
    function setup() {
        const ui = Object.create(ChatUI.prototype);
        ui._resultActions = [];
        const row = document.createElement('details');
        row.innerHTML = '<summary><span class="row-status running"></span></summary>' +
            '<div class="agent-turn-row-body"></div>';
        ui.currentTurn = { rowsByIter: new Map([[1, row]]) };
        ui.scrollToBottom = () => {};
        return { ui, body: row.querySelector('.agent-turn-row-body') };
    }

    it('puts an action\'s elements under the result it was given', () => {
        const { ui, body } = setup();
        const seen = [];
        ui.addResultAction(r => {
            seen.push(r);
            if (r.name !== 'query') return null;
            const b = document.createElement('button');
            b.textContent = 'CSV';
            return b;
        });
        ui.showToolResults([
            { name: 'get_schema', success: true, result: '{}' },
            { name: 'query', success: true, result: '| a |', sqlQuery: 'SELECT 1 AS a' },
        ], 1);
        const items = body.querySelectorAll('.tool-result-item');
        expect(items[0].querySelector('.tool-result-actions')).toBeNull();
        expect(items[1].querySelector('.tool-result-actions button').textContent).toBe('CSV');
        expect(seen.map(r => r.sqlQuery ?? null)).toEqual([null, 'SELECT 1 AS a']);
    });

    it('takes several elements, and a failing action costs only its own', () => {
        const { ui, body } = setup();
        ui.addResultAction(() => { throw new Error('boom'); });
        ui.addResultAction(() => ['a', 'b'].map(t => Object.assign(document.createElement('button'), { textContent: t })));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ui.showToolResults([{ name: 'query', success: true, result: 'ok' }], 1);
        warn.mockRestore();
        expect([...body.querySelectorAll('.tool-result-actions button')].map(b => b.textContent)).toEqual(['a', 'b']);
        expect(body.querySelector('.tool-output').textContent).toBe('ok');
    });

    it('stops adding once removed', () => {
        const { ui, body } = setup();
        const off = ui.addResultAction(() => document.createElement('button'));
        off();
        ui.showToolResults([{ name: 'query', success: true, result: 'ok' }], 1);
        expect(body.querySelector('.tool-result-actions')).toBeNull();
    });
});
