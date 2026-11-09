// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatUI } from '../ui/chat-ui.js';

/** glen#443: the bring-your-own-key panel saves a model id next to the key. */
function makeUI(llm = { models: [{ value: 'a', label: 'A' }] }) {
    const ui = Object.create(ChatUI.prototype);
    ui.config = { llm, _userProvidedMode: true };
    const wrap = document.createElement('div');
    ui.messagesEl = document.createElement('div');
    wrap.appendChild(ui.messagesEl);
    document.body.replaceChildren(wrap);
    ui.modelSelector = document.createElement('select');
    ui.agent = { setModel: vi.fn(function (v) { this.selectedModel = v; }), _reasoningCapable: () => false, getModelConfig: () => ({}) };
    return ui;
}

const panel = () => document.getElementById('api-settings-panel');
const set = (id, v) => { panel().querySelector(id).value = v; };
const save = () => panel().querySelector('#settings-save').click();

describe('ChatUI settings panel: model id (#443)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'x/one' }, { id: 'y/two' }] }) })));
    });

    it('saves a typed model id, lists it first and selects it', () => {
        const ui = makeUI();
        ui.showSettingsPanel();
        set('#settings-api-key', 'sk-1');
        set('#settings-model', 'anthropic/claude-x');
        save();
        expect(localStorage.getItem('geo-agent-model')).toBe('anthropic/claude-x');
        expect([...ui.modelSelector.options].map(o => o.value)).toEqual(['anthropic/claude-x', 'a']);
        expect(ui.agent.setModel).toHaveBeenLastCalledWith('anthropic/claude-x');
        expect(ui.modelSelector.value).toBe('anthropic/claude-x');
    });

    it('clearing the field removes the saved id and returns to the app list', () => {
        localStorage.setItem('geo-agent-api-key', 'sk-1');
        localStorage.setItem('geo-agent-model', 'old');
        const ui = makeUI();
        ui.showSettingsPanel();
        expect(panel().querySelector('#settings-model').value).toBe('old');
        set('#settings-model', '');
        save();
        expect(localStorage.getItem('geo-agent-model')).toBeNull();
        expect([...ui.modelSelector.options].map(o => o.value)).toEqual(['a']);
    });

    it('suggests the endpoint\'s own models', async () => {
        const ui = makeUI();
        ui.showSettingsPanel();
        await vi.waitFor(() => expect(panel().querySelectorAll('#settings-model-options option')).toHaveLength(2));
        expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
    });

    it('escapes a saved id in the panel', () => {
        localStorage.setItem('geo-agent-model', '"><img src=x>');
        makeUI().showSettingsPanel();
        expect(panel().querySelector('img')).toBeNull();
        expect(panel().querySelector('#settings-model').value).toBe('"><img src=x>');
    });
});
