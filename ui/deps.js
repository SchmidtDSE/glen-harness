/**
 * The page globals ChatUI renders with: marked and DOMPurify for the model's
 * markdown (without both, renderMarkdown falls back to escaped plain text)
 * and highlight.js for SQL. geo-agent pages load them with <script> tags; a
 * host that mounts the chat on demand can call loadChatDeps() instead, so a
 * page that never opens the chat never loads them.
 *
 * Versions and subresource-integrity hashes match geo-agent's index.html.
 */

export const CHAT_SCRIPTS = [
    {
        global: 'marked',
        src: 'https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js',
        integrity: 'sha384-ZD0fTOwPMHi7zM6WTVIWJR21I07lq0ccnqz3J6WMvQKG9thh4y7TA1QE6PJu0Af8',
    },
    {
        global: 'DOMPurify',
        src: 'https://cdn.jsdelivr.net/npm/dompurify@3.4.8/dist/purify.min.js',
        integrity: 'sha384-jrsBdrv4eDpEYIq32u13DPbvB6tRmqIDnA6UlgFBoexpetaiWi7g/VbfMEL1WVen',
    },
    {
        global: 'hljs',
        src: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
        integrity: 'sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp',
    },
    {
        // registers itself with hljs, so it loads after it
        src: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js',
        integrity: 'sha384-8q00eP+tyV9451aJYD5ML3ftuHKsGnDcezp7EXMEclDg1fZVSoj8O+3VyJTkXmWp',
    },
];

/** Stylesheets the chat uses, relative to this module: chat.css, then chat-docked.css when docked. */
export function chatStylesheets({ docked = true } = {}) {
    const files = docked ? ['chat.css', 'chat-docked.css'] : ['chat.css'];
    return files.map(f => new URL(f, import.meta.url).href);
}

/**
 * Load the chat's scripts and stylesheets into the page, skipping any
 * already present. Resolves when the scripts have run; a script that fails
 * to load is logged and skipped, since ChatUI degrades without it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.docked=true] - also load chat-docked.css
 * @param {Document} [options.doc]
 */
export async function loadChatDeps({ docked = true, doc = document } = {}) {
    for (const href of chatStylesheets({ docked })) {
        if (doc.querySelector(`link[rel="stylesheet"][href="${href}"]`)) continue;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        doc.head.appendChild(link);
    }
    for (const s of CHAT_SCRIPTS) {
        if (s.global && globalThis[s.global]) continue;
        if (doc.querySelector(`script[src="${s.src}"]`)) continue;
        await new Promise(resolve => {
            const el = doc.createElement('script');
            el.src = s.src;
            el.integrity = s.integrity;
            el.crossOrigin = 'anonymous';
            el.onload = resolve;
            el.onerror = () => { console.warn(`[glen-harness] could not load ${s.src}`); resolve(); };
            doc.head.appendChild(el);
        });
    }
}
