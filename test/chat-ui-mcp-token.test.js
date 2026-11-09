// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatUI } from '../ui/chat-ui.js';

/** glen#442: the settings panel takes a data server (MCP) token. */
function makeUI({ userProvided = false } = {}) {
    const ui = Object.create(ChatUI.prototype);
    ui.config = { llm: {}, _userProvidedMode: userProvided };
    const wrap = document.createElement('div');
    ui.messagesEl = document.createElement('div');
    wrap.appendChild(ui.messagesEl);
    ui.footerRightEl = document.createElement('div');
    document.body.replaceChildren(wrap, ui.footerRightEl);
    ui._messages = [];
    ui.addMessage = (role, text) => ui._messages.push({ role, text });
    return ui;
}
const panel = () => document.getElementById('api-settings-panel');
const flush = () => new Promise(r => setTimeout(r, 0));

describe('ChatUI MCP token (#442)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    });

    it('on a refused boot: says why, shows the button and opens the panel with only the token field', () => {
        const ui = makeUI();
        ui.enableMcpToken({ authFailed: true, apply: vi.fn() });
        expect(ui._messages[0].text).toMatch(/needs an access token/);
        expect(document.getElementById('settings-btn')).not.toBeNull();
        expect(panel().querySelector('#settings-mcp-token')).not.toBeNull();
        expect(panel().querySelector('#settings-api-key')).toBeNull();
    });

    it('adds no button when nothing failed and no token is saved', () => {
        const ui = makeUI();
        ui.enableMcpToken({ authFailed: false, apply: vi.fn() });
        expect(document.getElementById('settings-btn')).toBeNull();
        expect(panel()).toBeNull();
    });

    it('shows the button when a token is saved, so it can be changed', () => {
        localStorage.setItem('geo-agent-mcp-token', 'old');
        makeUI().enableMcpToken({ apply: vi.fn() });
        expect(document.getElementById('settings-btn')).not.toBeNull();
    });

    it('saves a new token and hands it to apply', async () => {
        const apply = vi.fn(async () => {});
        const ui = makeUI();
        ui.enableMcpToken({ authFailed: true, apply });
        panel().querySelector('#settings-mcp-token').value = 'tok-1';
        panel().querySelector('#settings-save').click();
        await flush();
        expect(localStorage.getItem('geo-agent-mcp-token')).toBe('tok-1');
        expect(apply).toHaveBeenCalledWith('tok-1');
        expect(ui._messages.at(-1).text).toMatch(/Connected/);
    });

    it('leaves a saved token alone when the mask is not edited', async () => {
        localStorage.setItem('geo-agent-mcp-token', 'old');
        const apply = vi.fn(async () => {});
        const ui = makeUI();
        ui.enableMcpToken({ apply });
        ui.showSettingsPanel();
        expect(panel().querySelector('#settings-mcp-token').value).not.toBe('old');
        panel().querySelector('#settings-save').click();
        await flush();
        expect(apply).not.toHaveBeenCalled();
        expect(localStorage.getItem('geo-agent-mcp-token')).toBe('old');
    });

    it('clearing the field removes the token', async () => {
        localStorage.setItem('geo-agent-mcp-token', 'old');
        const apply = vi.fn(async () => {});
        const ui = makeUI();
        ui.enableMcpToken({ apply });
        ui.showSettingsPanel();
        const input = panel().querySelector('#settings-mcp-token');
        input.dispatchEvent(new Event('focus'));
        expect(input.value).toBe('');
        panel().querySelector('#settings-save').click();
        await flush();
        expect(localStorage.getItem('geo-agent-mcp-token')).toBeNull();
        expect(apply).toHaveBeenCalledWith('');
    });

    it('reports a token the server refuses', async () => {
        const ui = makeUI();
        ui.enableMcpToken({ authFailed: true, apply: vi.fn(async () => { throw new Error('HTTP 401'); }) });
        panel().querySelector('#settings-mcp-token').value = 'bad';
        panel().querySelector('#settings-save').click();
        await flush();
        expect(ui._messages.at(-1)).toMatchObject({ role: 'error' });
    });

    it('in user-provided mode shows both the LLM fields and the token field', () => {
        const ui = makeUI({ userProvided: true });
        ui.enableMcpToken({ apply: vi.fn() });
        ui.showSettingsPanel();
        expect(panel().querySelector('#settings-api-key')).not.toBeNull();
        expect(panel().querySelector('#settings-mcp-token')).not.toBeNull();
    });

    it('without enableMcpToken the panel has no token field', () => {
        makeUI({ userProvided: true }).showSettingsPanel();
        expect(panel().querySelector('#settings-mcp-token')).toBeNull();
    });
});
