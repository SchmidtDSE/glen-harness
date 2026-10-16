/**
 * glen-harness — the agent harness behind GLEN apps.
 *
 *   Agent         the tool-use loop against any OpenAI-compatible endpoint
 *   ToolRegistry  local (in-process) and remote (MCP) tools behind one dispatch
 *   MCPClient     Streamable HTTP transport to an MCP server
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
