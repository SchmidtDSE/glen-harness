/**
 * glen-harness/core — the agent loop and tool registry without the MCP
 * client, for apps whose tools all run in the page (glen core's map-only
 * apps, for example). Nothing reachable from here imports the MCP SDK.
 * An app that later wants MCP tools imports ./mcp-client.js beside it and
 * passes its tools to ToolRegistry#registerRemote.
 */
export { Agent } from './agent.js';
export {
    ToolRegistry,
    sqlArg,
    isFailedToolResult,
    REMOTE_SQL_ARGS,
    LOCAL_SQL_ARGS,
} from './tool-registry.js';
export {
    applyProxyModelList,
    buildUserModels,
    loadUserSettings,
    fetchModelIds,
    modelsFromTierList,
    STORAGE_KEY_API,
    STORAGE_KEY_ENDPOINT,
    STORAGE_KEY_MODEL,
} from './llm-models.js';
