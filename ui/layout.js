/**
 * The DOM ChatUI mounts into, for a host without a layout of its own.
 * geo-agent builds the same elements in its layout-manager; the ids are the
 * ones chat.css and chat-docked.css style.
 *
 *   const mount = buildChatPanel(column, { placeholder: 'Ask about this area' });
 *   const ui = new ChatUI(agent, config, mount);
 */

import { micIcon } from './icons.js';

/**
 * Build the chat panel inside `parent`.
 *
 * @param {HTMLElement} parent
 * @param {Object} [options]
 * @param {string} [options.placeholder] - input placeholder
 * @param {boolean} [options.docked=true] - style for a page column (chat-docked.css)
 *   rather than as a panel floating over a map
 * @returns {Object} the mount ChatUI takes:
 *   { container, messages, input, send, mic, header, footer, footerRight }
 */
export function buildChatPanel(parent, { placeholder = 'Ask about the data…', docked = true } = {}) {
    const doc = parent.ownerDocument || document;
    const el = (tag, attrs = {}) => {
        const e = doc.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
    };

    const container = el('div', { id: 'chat-container' });
    if (docked) container.classList.add('chat-docked');

    const messages = el('div', { id: 'chat-messages', 'aria-live': 'polite' });

    const inputContainer = el('div', { id: 'chat-input-container' });
    const input = el('textarea', { id: 'chat-input', placeholder, rows: '1', autocomplete: 'off', 'aria-label': 'Message' });
    const mic = el('button', { id: 'chat-mic', type: 'button', title: 'Record voice input', 'aria-label': 'Record voice input' });
    mic.hidden = true;
    mic.innerHTML = micIcon();
    const send = el('button', { id: 'chat-send', type: 'button' });
    send.textContent = 'Send';
    inputContainer.append(input, mic, send);

    const footer = el('div', { id: 'chat-footer' });
    const footerRight = el('div', { id: 'chat-footer-right' });
    footerRight.append(el('select', { id: 'model-selector', title: 'Select model' }));
    footer.append(footerRight);

    container.append(messages, inputContainer, footer);
    parent.appendChild(container);
    return { container, messages, input, send, mic, header: null, footer, footerRight };
}
