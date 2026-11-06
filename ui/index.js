/**
 * glen-harness/ui: the chat interface for the harness, extracted from
 * geo-agent. Unlike src/, these modules use the DOM.
 */

export { ChatUI, CARBON_DASHBOARD_URL, renderMarkdown } from './chat-ui.js';
export { buildChatPanel } from './layout.js';
export { loadChatDeps, chatStylesheets, CHAT_SCRIPTS } from './deps.js';
export { resolveExportConfig } from './export-config.js';
export { buildReportHtml } from './export-report.js';
