import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPClient } from '../src/mcp-client.js';
import { PostMessageTransport } from '../src/post-message-transport.js';

// A MessageChannel stands in for page ↔ Worker: both ends have postMessage and
// addEventListener('message'), as a Worker and a worker's `self` do.

function echoServer() {
    const server = new Server({ name: 'echo', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({
        content: [{ type: 'text', text: `echo: ${req.params.arguments.text}` }],
    }));
    return server;
}

let consoleSpies;
beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map(m => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => consoleSpies.forEach(s => s.mockRestore()));

describe('PostMessageTransport', () => {
    it('carries MCP between MCPClient and a server over a message channel', async () => {
        const { port1, port2 } = new MessageChannel();
        await echoServer().connect(new PostMessageTransport(port2));

        const mcp = new MCPClient('worker:echo', {}, { transport: () => new PostMessageTransport(port1) });
        await mcp.connect();
        expect(mcp.getTools().map(t => t.name)).toEqual(['echo']);
        expect(await mcp.callTool('echo', { text: 'hi' })).toBe('echo: hi');

        await mcp.disconnect();
        port1.close();
    });

    it('queues messages that arrive before start(), as from a page that speaks before the worker is ready', async () => {
        const { port1, port2 } = new MessageChannel();
        const serverSide = new PostMessageTransport(port2); // listening, not started

        const mcp = new MCPClient('worker:echo', {}, { transport: () => new PostMessageTransport(port1) });
        const connecting = mcp.connect(); // sends `initialize` now
        await new Promise(r => setTimeout(r, 20));

        await echoServer().connect(serverSide); // starts, replays the queue
        await connecting;
        expect(mcp.isConnected).toBe(true);

        await mcp.disconnect();
        port1.close();
    });

    it('builds a fresh transport on every connect', async () => {
        const { port1, port2 } = new MessageChannel();
        await echoServer().connect(new PostMessageTransport(port2));

        const factory = vi.fn(() => new PostMessageTransport(port1));
        const mcp = new MCPClient('worker:echo', {}, { transport: factory });
        await mcp.connect();
        await mcp.disconnect();
        await mcp.connect();
        expect(factory).toHaveBeenCalledTimes(2);
        expect(await mcp.callTool('echo', { text: 'again' })).toBe('echo: again');

        await mcp.disconnect();
        port1.close();
    });

    it('stops listening and refuses to send once closed', async () => {
        const { port1 } = new MessageChannel();
        const t = new PostMessageTransport(port1);
        const onclose = vi.fn();
        t.onclose = onclose;
        await t.start();
        await t.close();
        expect(onclose).toHaveBeenCalledTimes(1);
        await expect(t.send({ jsonrpc: '2.0', method: 'ping' })).rejects.toThrow('Not connected');
        port1.close();
    });

    it('refuses a second start', async () => {
        const { port1 } = new MessageChannel();
        const t = new PostMessageTransport(port1);
        await t.start();
        await expect(t.start()).rejects.toThrow('already started');
        await t.close();
        port1.close();
    });
});
