import { describe, it, expect } from 'vitest';
import {
    STORAGE_KEY_MCP_TOKEN, userTokenApplies, withUserToken, isMcpAuthError, loadMcpToken,
} from '../src/mcp-token.js';
import * as viaClient from '../src/mcp-client.js';

/** glen#442: a visitor's token for the app's MCP server. */
const PAGES = 'https://schmidtdse.github.io';

describe('userTokenApplies', () => {
    it('applies to a cross-origin server with no Authorization header', () => {
        expect(userTokenApplies({ url: 'https://duckdb-mcp.nrp-nautilus.io/mcp' }, PAGES)).toBe(true);
        expect(userTokenApplies({ url: 'https://duckdb-mcp.nrp-nautilus.io/mcp', headers: {} }, PAGES)).toBe(true);
    });

    it("never overrides the deployment's own token, whatever its case", () => {
        expect(userTokenApplies({ url: 'https://x.org/mcp', headers: { Authorization: 'Bearer a' } }, PAGES)).toBe(false);
        expect(userTokenApplies({ url: 'https://x.org/mcp', headers: { authorization: 'Bearer a' } }, PAGES)).toBe(false);
    });

    it("leaves a same-origin relay alone, so basic auth keeps working (glen#420)", () => {
        expect(userTokenApplies({ url: '/api/mcp' }, PAGES)).toBe(false);
        expect(userTokenApplies({ url: `${PAGES}/mcp` }, PAGES)).toBe(false);
    });

    it('rejects a missing or unparseable url', () => {
        expect(userTokenApplies({}, PAGES)).toBe(false);
        expect(userTokenApplies(null, PAGES)).toBe(false);
        expect(userTokenApplies({ url: 'http://[bad' }, PAGES)).toBe(false);
    });

    it('applies to an absolute url when there is no page origin (Node)', () => {
        expect(userTokenApplies({ url: 'https://x.org/mcp' }, undefined)).toBe(true);
    });
});

describe('withUserToken', () => {
    it('adds a bearer header and keeps the others', () => {
        expect(withUserToken({ 'X-A': '1' }, 'tok')).toEqual({ 'X-A': '1', Authorization: 'Bearer tok' });
    });
    it('returns a copy without one when there is no token', () => {
        const h = { 'X-A': '1' };
        const out = withUserToken(h, '');
        expect(out).toEqual(h);
        expect(out).not.toBe(h);
        expect(withUserToken(undefined, '')).toEqual({});
    });
});

describe('isMcpAuthError', () => {
    it('matches the SDK error for 401 and 403 only', () => {
        expect(isMcpAuthError(new Error('Error POSTing to endpoint (HTTP 401): Unauthorized'))).toBe(true);
        expect(isMcpAuthError(new Error('Error POSTing to endpoint (HTTP 403): Forbidden'))).toBe(true);
        expect(isMcpAuthError(new Error('Error POSTing to endpoint (HTTP 503): down'))).toBe(false);
        expect(isMcpAuthError(new Error('Failed to fetch'))).toBe(false);
        expect(isMcpAuthError(null)).toBe(false);
    });
});

describe('loadMcpToken', () => {
    it('reads the saved token, or empty when storage is missing or throws', () => {
        const store = { getItem: (k) => (k === STORAGE_KEY_MCP_TOKEN ? 'tok' : null) };
        expect(loadMcpToken(store)).toBe('tok');
        expect(loadMcpToken({ getItem: () => null })).toBe('');
        expect(loadMcpToken({ getItem: () => { throw new Error('denied'); } })).toBe('');
        expect(loadMcpToken(null)).toBe('');
    });

    it('is re-exported from the MCP client module', () => {
        expect(viaClient.loadMcpToken).toBe(loadMcpToken);
        expect(viaClient.STORAGE_KEY_MCP_TOKEN).toBe('geo-agent-mcp-token');
    });
});
