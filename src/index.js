/**
 * glen-harness — the agent harness behind GLEN apps.
 *
 *   Agent         the tool-use loop against any OpenAI-compatible endpoint
 *   ToolRegistry  local (in-process) and remote (MCP) tools behind one dispatch
 *   MCPClient     connection to an MCP server, over Streamable HTTP by default
 *   PostMessageTransport  MCP to a server in a Web Worker
 */
export { Agent } from './agent.js';
export {
    ToolRegistry,
    sqlArg,
    isFailedToolResult,
    REMOTE_SQL_ARGS,
    LOCAL_SQL_ARGS,
} from './tool-registry.js';
export { MCPClient } from './mcp-client.js';
export { PostMessageTransport } from './post-message-transport.js';
