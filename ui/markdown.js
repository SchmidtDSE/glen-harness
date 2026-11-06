/**
 * Rendering model text for the chat: the credential scrub, the argument keys
 * never shown, and markdown to sanitized HTML. The live chat and the session
 * export both use these; export-report.js re-exports them.
 */

/**
 * Defense-in-depth credential scrub. Replaces credential-shaped tokens with
 * `[REDACTED]`. Each pattern requires a quoted value or structured
 * delimiter, so false positives in prose are unlikely.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubCredentials(text) {
    if (text === '' || text == null) return text;

    let out = text;

    // DuckDB CREATE SECRET — KEY_ID 'value' / SECRET 'value'. An empty value
    // is the anonymous-access spelling and hides nothing, so it stays.
    out = out.replace(/(KEY_ID)\s+'[^']+'/gi, '$1 [REDACTED]');
    out = out.replace(/(\bSECRET)\s+'[^']+'/gi, '$1 [REDACTED]');

    // json/yaml/python access key assignments
    out = out.replace(
        /((?:aws_)?access_key(?:_id)?)["']?\s*([:=])\s*(['"])[^'"]+\3/gi,
        '$1$2 [REDACTED]'
    );
    out = out.replace(
        /((?:aws_)?secret(?:_access)?_key)["']?\s*([:=])\s*(['"])[^'"]+\3/gi,
        '$1$2 [REDACTED]'
    );

    // Bearer tokens
    out = out.replace(/(Authorization:)\s*Bearer\s+\S+/gi, '$1 [REDACTED]');

    // Pre-signed URL signature/credential
    out = out.replace(/X-Amz-Signature=[^&\s'"]+/gi, 'X-Amz-Signature=[REDACTED]');
    out = out.replace(/X-Amz-Credential=[^&\s'"]+/gi, 'X-Amz-Credential=[REDACTED]');
    out = out.replace(/X-Amz-Security-Token=[^&\s'"]+/gi, 'X-Amz-Security-Token=[REDACTED]');

    return out;
}

/**
 * Tool-call argument keys whose values are credentials and must never be
 * rendered to the chat or to any export. Used by both `renderToolCallArgs`
 * (live chat) and `exportHtml` (download).
 */
export const REDACTED_KEYS = ['s3_key', 's3_secret', 's3_endpoint', 's3_scope', 'catalog_token'];

/**
 * Render LLM-derived text to HTML for innerHTML insertion. The model can be
 * steered by anything it reads (dataset values, STAC descriptions), so its
 * output may carry attacker-controlled markup: scrub credential-shaped
 * tokens, parse markdown, then sanitize through DOMPurify. If either page
 * global is missing, fail closed to escaped plain text rather than raw HTML.
 *
 * @param {string} md
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(md) {
    const text = scrubCredentials(String(md ?? ''));
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(marked.parse(text));
    }
    if (!renderMarkdown._warned) {
        renderMarkdown._warned = true;
        console.warn('[ChatUI] marked and/or DOMPurify not loaded — chat text will render as escaped plain text. Check the CDN <script> tags in index.html.');
    }
    return `<pre>${escapeHtmlText(text)}</pre>`;
}

/** DOM-free HTML escape (renderMarkdown fallback path). */
export function escapeHtmlText(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
