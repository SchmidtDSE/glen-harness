import { describe, it, expect } from 'vitest';
import { sqlArg, REMOTE_SQL_ARGS, LOCAL_SQL_ARGS, ToolRegistry } from '../src/tool-registry.js';

/**
 * Which argument holds a tool call's SQL — one rule (sqlArg), applied at every
 * site that reads it. Before this, four sites each kept their own list: the
 * registry and the export missed the `sql` alias (ca-30x30, v3.34.0: the
 * query landed in "Consulted" and the export lost its download buttons), and
 * the chat panel read a local `query` (geocode's place name) as SQL.
 *
 * The remote names mirror mcp-data-server: `query` takes `sql_query`,
 * `register_hex_tiles` takes `sql`, and each accepts the other (#321).
 */

const SQL = "SELECT count(*) AS n FROM read_parquet('s3://public-x/hex/h0=*/data_0.parquet')";
const REMOTE_TOOLS = ['query', 'register_hex_tiles'];

describe('sqlArg', () => {
    it('finds the SQL under every name the MCP server accepts', () => {
        expect(REMOTE_SQL_ARGS).toEqual(['sql_query', 'sql', 'query']);
        for (const key of REMOTE_SQL_ARGS) {
            expect(sqlArg({ [key]: SQL }, true)).toEqual({ key, sql: SQL });
        }
    });

    it('prefers the canonical name when several are present', () => {
        expect(sqlArg({ query: 'c', sql: 'b', sql_query: 'a' }, true)).toEqual({ key: 'sql_query', sql: 'a' });
        expect(sqlArg({ query: 'c', sql: 'b' }, true)).toEqual({ key: 'sql', sql: 'b' });
    });

    it('reads only `sql` for a local tool — a local `query` is a place name', () => {
        expect(LOCAL_SQL_ARGS).toEqual(['sql']);
        expect(sqlArg({ sql: SQL }, false)).toEqual({ key: 'sql', sql: SQL });
        expect(sqlArg({ query: 'Yosemite' }, false)).toBe(null);
        expect(sqlArg({ sql_query: SQL }, false)).toBe(null);
    });

    it('skips empty and non-string values, and tolerates junk args', () => {
        expect(sqlArg({ sql_query: '   ', sql: SQL }, true)).toEqual({ key: 'sql', sql: SQL });
        expect(sqlArg({ sql_query: 42 }, true)).toBe(null);
        expect(sqlArg(null, true)).toBe(null);
        expect(sqlArg('SELECT 1', true)).toBe(null);
    });
});

describe('every site applies the one rule', () => {
    const remoteReg = () => {
        const reg = new ToolRegistry();
        reg.registerRemote(REMOTE_TOOLS.map(name => ({ name, description: '', inputSchema: { type: 'object', properties: {} } })),
            { callTool: async () => 'rows' });
        reg.registerLocal({ name: 'geocode', description: '', inputSchema: { type: 'object', properties: {} }, execute: () => 'ok' });
        return reg;
    };

    it('registry: records sqlQuery for every remote tool under every name', async () => {
        const reg = remoteReg();
        for (const tool of REMOTE_TOOLS) {
            for (const key of REMOTE_SQL_ARGS) {
                expect((await reg.execute(tool, { [key]: SQL })).sqlQuery, `${tool}/${key}`).toBe(SQL);
            }
        }
    });
});
