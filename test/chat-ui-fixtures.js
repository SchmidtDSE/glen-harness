import { Agent } from '../src/agent.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { buildChatPanel } from '../ui/layout.js';
import { ChatUI } from '../ui/chat-ui.js';

export const CONFIG = {
    llm_models: [{ value: 'a', label: 'Model A', endpoint: 'https://example.org/v1', api_key: 'k' }, { value: 'b', label: 'Model B' }],
    llm_model: 'a',
    welcome: { message: 'Hello', examples: ['First question'] },
};

export function mountUI(config = CONFIG) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const mount = buildChatPanel(parent, { placeholder: 'Ask about this area' });
    const agent = new Agent(config, new ToolRegistry());
    return { parent, mount, agent, ui: new ChatUI(agent, config, mount) };
}
