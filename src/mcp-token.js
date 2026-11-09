/**
 * mcp-token.js — A visitor's own token for an app's MCP server
 * (SchmidtDSE/glen#442).
 *
 * A static deployment (GitHub Pages) has nowhere to keep a secret, so when its
 * MCP server wants a token, the visitor enters one in the chat's settings
 * panel. It is saved in their browser and sent as a bearer token to that
 * server only. Nothing here imports the MCP SDK, so the chat can use it.
 */

/** Where the token is saved, beside the user-provided LLM key. */
export const STORAGE_KEY_MCP_TOKEN = 'geo-agent-mcp-token';

/**
 * Whether a visitor's token may be sent to this server.
 *
 * Only when the deployment gave it no token, so a deployment's own token
 * always wins, and only when the server is on another origin. A same-origin
 * URL such as `/api/mcp` is the deployment's own relay, which adds the token
 * itself; a header set by the page there would also replace the browser's
 * saved basic-auth credentials (glen#420).
 *
 * @param {{url: string, headers?: Object}} server
 * @param {string} [pageOrigin] - defaults to the current page's origin
 */
export function userTokenApplies(server, pageOrigin = globalThis.location?.origin) {
    if (!server?.url || hasAuthorization(server.headers)) return false;
    let url;
    try {
        url = new URL(server.url, pageOrigin || undefined);
    } catch {
        return false;
    }
    return !pageOrigin || url.origin !== pageOrigin;
}

/** The headers with the visitor's token added, or unchanged when there is none. */
export function withUserToken(headers = {}, token) {
    return token ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers };
}

/**
 * Whether an MCP connection error is the server refusing our credentials.
 * The SDK reports a non-OK POST as `Error POSTing to endpoint (HTTP 401): …`.
 */
export function isMcpAuthError(err) {
    return /\(HTTP 40[13]\)/.test(String(err?.message || ''));
}

/** The saved token, or '' (storage can throw in a private window). */
export function loadMcpToken(storage = globalThis.localStorage) {
    try { return storage?.getItem(STORAGE_KEY_MCP_TOKEN) || ''; } catch { return ''; }
}

function hasAuthorization(headers) {
    return Object.keys(headers || {}).some(k => k.toLowerCase() === 'authorization');
}
