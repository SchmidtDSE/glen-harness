// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatUI } from '../ui/chat-ui.js';
import { buildChatPanel } from '../ui/layout.js';
import { chatStylesheets } from '../ui/deps.js';
import { Agent } from '../src/agent.js';
import { ToolRegistry } from '../src/tool-registry.js';

const CONFIG = {
    llm_models: [{ value: 'a', label: 'Model A', endpoint: 'https://example.org/v1', api_key: 'k' }, { value: 'b', label: 'Model B' }],
    llm_model: 'a',
    welcome: { message: 'Hello', examples: ['First question'] },
};

function mountUI(config = CONFIG) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const mount = buildChatPanel(parent, { placeholder: 'Ask about this area' });
    const agent = new Agent(config, new ToolRegistry());
    return { parent, mount, agent, ui: new ChatUI(agent, config, mount) };
}

describe('buildChatPanel', () => {
    it('builds the elements ChatUI mounts into, docked by default', () => {
        const parent = document.createElement('div');
        const m = buildChatPanel(parent, { placeholder: 'Ask' });
        expect(m.container.id).toBe('chat-container');
        expect(m.container.classList.contains('chat-docked')).toBe(true);
        expect(m.input.tagName).toBe('TEXTAREA');
        expect(m.input.placeholder).toBe('Ask');
        expect(m.mic.hidden).toBe(true);
        expect(m.footerRight.querySelector('#model-selector')).not.toBe(null);
        expect(parent.firstElementChild).toBe(m.container);
    });

    it('can build the floating panel', () => {
        const m = buildChatPanel(document.createElement('div'), { docked: false });
        expect(m.container.classList.contains('chat-docked')).toBe(false);
    });
});

describe('ChatUI on a buildChatPanel mount', () => {
    it('wires the send button, model list, welcome and footer toggles', () => {
        const { mount, ui } = mountUI();
        expect(mount.send.textContent).toBe('Send');
        expect([...mount.footerRight.querySelectorAll('#model-selector option')].map(o => o.value)).toEqual(['a', 'b']);
        expect(mount.messages.querySelector('.welcome-example-btn').textContent).toBe('First question');
        expect(mount.footerRight.querySelector('#auto-approve-btn')).not.toBe(null);
        // no layer panel: export goes in the footer
        expect(mount.footerRight.querySelector('#export-btn')).not.toBe(null);
        expect(ui.busy).toBe(false);
    });

    it('turns the send button into Stop while busy, and Stop aborts the agent', () => {
        const { mount, ui, agent } = mountUI();
        let aborted = 0;
        agent.abort = () => { aborted++; };
        ui.busy = true;
        ui._syncInputControls();
        expect(mount.send.textContent).toBe('■');
        expect(mount.send.classList.contains('stop')).toBe(true);
        mount.send.click();
        expect(aborted).toBe(1);
    });

    it('appends host elements to the message list', () => {
        const { mount, ui } = mountUI();
        const card = document.createElement('section');
        card.className = 'card';
        expect(ui.addElement(card)).toBe(card);
        expect(mount.messages.lastElementChild).toBe(card);
    });
});

describe('ChatUI.exportRow', () => {
    it('places the export button in the row a host returns', () => {
        const row = document.createElement('div');
        class HostUI extends ChatUI {
            exportRow() { return row; }
        }
        const parent = document.createElement('div');
        const mount = buildChatPanel(parent);
        new HostUI(new Agent(CONFIG, new ToolRegistry()), CONFIG, mount);
        const btn = row.querySelector('#export-btn');
        expect(btn).not.toBe(null);
        expect(btn.className).toBe('panel-btn');
        expect(mount.footerRight.querySelector('#export-btn')).toBe(null);
    });
});

describe('chatStylesheets', () => {
    it('lists chat.css, and chat-docked.css when docked, next to the module', () => {
        const [a, b] = chatStylesheets();
        expect(a).toMatch(/\/ui\/chat\.css$/);
        expect(b).toMatch(/\/ui\/chat-docked\.css$/);
        expect(chatStylesheets({ docked: false })).toHaveLength(1);
    });
});
