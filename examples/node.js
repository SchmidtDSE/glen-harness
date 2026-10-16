#!/usr/bin/env node
// Run the harness from Node with no browser and no build step: the same files
// a GLEN web app loads from jsDelivr.
//
//   LLM_ENDPOINT=https://openrouter.ai/api/v1 LLM_API_KEY=... LLM_MODEL=... \
//     node examples/node.js "How many protected areas are in California?"
//
// MCP_URL defaults to the public GLEN data server. With no LLM_API_KEY set, the
// script lists the MCP tools and stops.

import { Agent, ToolRegistry, MCPClient } from '../src/index.js';

const question = process.argv.slice(2).join(' ') || 'What datasets can you query?';
const mcpUrl = process.env.MCP_URL || 'https://duckdb-mcp.carlboettiger.info/mcp';

const mcp = new MCPClient(mcpUrl);
await mcp.connect();

const registry = new ToolRegistry();
registry.registerRemote(mcp.getTools(), mcp);
// A local tool runs in-process, next to the loop. In geo-agent these drive the map.
registry.registerLocal({
    name: 'current_time',
    description: 'Current date and time (ISO 8601).',
    inputSchema: { type: 'object', properties: {} },
    execute: () => new Date().toISOString(),
});
console.log('Tools:', registry.getNames().join(', '));

if (!process.env.LLM_API_KEY) {
    console.log('Set LLM_ENDPOINT, LLM_API_KEY and LLM_MODEL to run the agent loop.');
    await mcp.disconnect();
    process.exit(0);
}

const agent = new Agent({
    llm_models: [{
        value: process.env.LLM_MODEL,
        endpoint: process.env.LLM_ENDPOINT,
        api_key: process.env.LLM_API_KEY,
    }],
}, registry, { clientName: 'glen-harness-example/node' });

agent.setSystemPrompt('You answer questions about geospatial data using the tools provided.');
agent.onToolProposal = async (calls) => {
    for (const c of calls) console.log(`→ ${c.function.name} ${c.function.arguments}`);
    return { approved: true };
};

const { response } = await agent.processMessage(question);
console.log('\n' + response);
await mcp.disconnect();
