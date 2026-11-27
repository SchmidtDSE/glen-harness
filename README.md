# glen-harness

The agent harness behind GLEN apps: the loop that sends a conversation and a set of tools to a language model, runs the tool calls the model makes, and returns the results to the model until it answers. It is written in plain JavaScript (ES modules) and runs unchanged in a web browser and in Node.

This is a draft. The code was extracted from [boettiger-lab/geo-agent](https://github.com/boettiger-lab/geo-agent) at commit `f0b144f`, where it runs in production in every GLEN map app. Issue numbers in code comments refer to geo-agent unless another repository is named.

## Modules

| Module | What it does |
|---|---|
| `src/agent.js` | `Agent`: the tool-use loop against any OpenAI-compatible Chat Completions endpoint. See [Agent loop](#agent-loop) for what it does. |
| `src/tool-registry.js` | `ToolRegistry`: one dispatch for local tools (functions in the same process, such as map controls) and remote tools (on an MCP server). Converts tool schemas to the OpenAI function-calling format and memoizes idempotent metadata reads. |
| `src/mcp-client.js` | `MCPClient`: connection to an MCP server, with lazy reconnect. Streamable HTTP by default; pass `{ transport: () => … }` for any other MCP transport. |
| `src/post-message-transport.js` | `PostMessageTransport`: MCP over `postMessage`, for a server running in a Web Worker in the same page. |
| `src/llm-models.js` | Which models the picker offers: the open-llm-proxy's tier list (`applyProxyModelList`), and the models of a user who brings their own key (`buildUserModels`). See [Model list](#model-list). |
| `src/mcp-token.js` | A visitor's own token for an app's MCP server: when it may be sent (`userTokenApplies`) and whether a connection error is the server refusing it (`isMcpAuthError`). See [MCP token for visitors](#mcp-token-for-visitors). |
| `src/core.js` | The `./core` entry: `Agent` and `ToolRegistry` without the MCP client. Nothing it imports loads the MCP SDK. |
| `src/vendor/mcp-sdk.js` | The MCP SDK, pre-bundled so that no import map or third-party module host is needed. See [`src/vendor/README.md`](src/vendor/README.md). |

The harness in `src/` has no DOM code and no dependencies beyond the vendored MCP SDK, which only `mcp-client.js` imports. `src/llm-models.js` and `src/mcp-token.js` use `fetch` and `localStorage` when they are there and work without them. A host application connects its UI through callbacks on the `Agent` (`onToolProposal`, `onToolResults`, `onResponse`, `onCheckpoint`, and others).

## Agent loop

`Agent` in `src/agent.js` does four jobs. Issue numbers below are in SchmidtDSE/glen, which was boettiger-lab/geo-agent when the code was written.

### Tool-use loop

`processMessage` sends the system prompt, the conversation so far and the tool list to the model. When the reply contains tool calls, the agent runs them, adds the results to the conversation and calls the model again. It repeats until the model answers in text. Local tools always run without asking. Remote tools run once the host approves them through `onToolProposal`, or at once when auto-approve is on, which is the default. Each tool result is cut to 16,000 characters before it enters the conversation, so a large query result cannot fill the context window. When a turn ends, it stays in the conversation in a shorter form, so a follow-up question can see which numbers were computed and how. That form keeps the tool calls with their arguments, the first 1,000 characters of each result and the text the model wrote, and leaves out reasoning and the harness's own re-prompts. A turn is shortened once and not changed afterwards, so later requests keep the same prefix for the provider's prompt cache. Once the conversation passes 60,000 characters (`history_budget_chars`) or 100 messages (`history_max_messages`), each set per model or globally, the oldest turns are dropped, a few at a time, never splitting a tool call from its result. The message limit keeps a request under open-llm-proxy's 200-message limit on its public tier. `abort()` stops the turn at its next await, including during the model request.

### Turn limits

The agent pauses at a checkpoint after a set number of rounds that call remote tools: 15 with auto-approve (`max_tool_calls`) and 100 without (`max_tool_calls_manual`). At a checkpoint it asks the model for a progress summary without tools, keeps the turn, and resumes it when the user sends the next message, such as Continue. Rounds that call only local tools do not count toward that limit, so the same number of local-only rounds in a row also ends in a checkpoint; a model once looped on a failing local tool indefinitely ([glen#243](https://github.com/SchmidtDSE/glen/issues/243)). When every call in a round fails exactly as the round before did, the agent tells the model once that repeating the call will not help, and checkpoints if it repeats again ([glen#313](https://github.com/SchmidtDSE/glen/issues/313)). When a round repeats exactly a round that succeeded, the calls are not run again: the model is told the result is already in its context, and the agent checkpoints if it repeats once more ([#19](https://github.com/SchmidtDSE/glen-harness/issues/19)). A reply with no text and no tool call is asked for again once before the turn ends with a fallback message ([#25](https://github.com/SchmidtDSE/glen-harness/issues/25)). A final answer that announces a check or query it did not run, such as "Let me also verify there is nothing closer…" with no tool call, is sent back once: the model is told to run it or answer without announcing it. Offers to the user ("Want me to check…?", "say the word and I'll run it") and questions do not count ([#26](https://github.com/SchmidtDSE/glen-harness/issues/26)). When a reply stops at the output limit, none of its tool calls run, because the last call's arguments may be incomplete; a text answer is shown with a note that it was cut off, and otherwise the turn ends with an error ([glen#387](https://github.com/SchmidtDSE/glen/issues/387)).

### Request shaping

Sampling parameters (`temperature`, `top_p`, `seed`, `max_tokens`) are read per model and then globally, and `temperature` defaults to 0 so that answers do not depend on each endpoint's own default. A model that the deployment opts in through `reasoning_toggle` or `reasoning_default` is sent `enable_thinking`, which open-llm-proxy maps to each backend's own setting ([glen#283](https://github.com/SchmidtDSE/glen/issues/283)). A model that open-llm-proxy can control by reasoning level lists the levels in its settings as `reasoning_levels`, a subset of `none`, `low`, `medium` and `high`, with the proxy's default in `reasoning_level`. The chat then shows a level selector in place of the 🧠 on/off toggle. A level the user picks is sent as `reasoning_level`, which the proxy translates into that model's own setting; with no pick, nothing is sent and the proxy applies its default. Such a model is never sent `enable_thinking`, since a raw field would override the translation ([#23](https://github.com/SchmidtDSE/glen-harness/issues/23)). With `prompt_cache` set, the system prompt carries an Anthropic `cache_control` breakpoint ([glen#273](https://github.com/SchmidtDSE/glen/issues/273)). Each request times out after 600 seconds unless `llm_timeout_seconds` says otherwise, and every retry gets that full budget: a timeout is retried once, and a network error or 5xx response up to twice, after waiting 15 and then 60 seconds ([glen#437](https://github.com/SchmidtDSE/glen/issues/437)). The `X-Client` header goes only to trusted proxy hosts (`nrp-nautilus.io` by default, or `client_header_hosts`), because a custom header on any other endpoint can fail the browser's CORS check ([glen#254](https://github.com/SchmidtDSE/glen/issues/254)). A model without an `api_key` is sent no `Authorization` header, so a deployment behind basic auth keeps working ([glen#420](https://github.com/SchmidtDSE/glen/issues/420)). Each request is logged to the console when it starts and when it ends or fails, with the model, the number of messages, the attempt and the time taken, so a stalled or repeated request can be traced ([#24](https://github.com/SchmidtDSE/glen-harness/issues/24)).

### Tool-call recovery

Some models put reasoning or tool calls where the protocol does not expect them, and this code moves them back.

- `extractReasoning` takes reasoning from `reasoning_content` and from `<think>` blocks in the content, passes it to `onReasoning`, and removes it so it is not sent back to the model.
- `parseEmbeddedToolCalls` and its helpers find tool calls written into the content as JSON inside a `<tool_call>` or `<tool_code>` wrapper, with a missing or mismatched closing tag, in the flat or the nested OpenAI shape, and with `parameters` used for `arguments` ([glen#288](https://github.com/SchmidtDSE/glen/issues/288), [glen#295](https://github.com/SchmidtDSE/glen/issues/295)). `syntheticToolCalls` turns them into ordinary tool calls, and `stripEmbeddedCalls` removes the call text from what the user sees.
- `looksLikeAttemptedToolCall` detects text that looks like a tool call the parser could not read, and the agent asks the model to send the call again, at most twice a turn (`MAX_PARSE_RETRIES`) ([glen#288](https://github.com/SchmidtDSE/glen/issues/288), [glen#297](https://github.com/SchmidtDSE/glen/issues/297)).
- `normalizeToolCallArguments` re-serializes the arguments of every native tool call as valid JSON before the reply enters the history. A malformed argument string, such as one with an extra closing brace, would otherwise make every later request in the session fail with a 400 error ([glen#288](https://github.com/SchmidtDSE/glen/issues/288)).

A replay of every logged response from 2026-06-14 to 2026-11-26 through these functions showed which paths current models still need ([#3](https://github.com/SchmidtDSE/glen-harness/issues/3)). The paths that fired only on models no longer configured were removed: bare JSON calls with no wrapper, the `<function=NAME>` dialect and other non-JSON bodies inside a wrapper, and `scrubArgDialectLeaks`, which unwrapped argument values leaked in `<arg_value>` markers by GLM-5.2. Text in those forms now gets the re-prompt instead. The original reasons for the code are recorded in glen's [tool-call parsing design note](https://github.com/SchmidtDSE/glen/blob/main/docs/design/tool-call-parsing.md).

## Chat interface

`ui/` holds the chat interface that geo-agent apps show, extracted from geo-agent at `v3.36.0` so that other GLEN apps can use the same chat. It is separate from `src/` because it uses the DOM; Node programs and tests that need only the agent loop never load it.

| Module | What it does |
|---|---|
| `ui/chat-ui.js` | `ChatUI`: the chat panel over an `Agent`. A stop button and Esc abort a running turn, each turn folds into a collapsible list of reasoning and tool calls with their SQL and results, a paused turn can be continued or discarded, and the footer holds the model selector, auto-approve and reasoning toggles, voice input and session export. |
| `ui/layout.js` | `buildChatPanel(parent, { placeholder })`: the elements `ChatUI` mounts into, for a host without a layout of its own. |
| `ui/deps.js` | `loadChatDeps()`: loads `chat.css`, `chat-docked.css`, and the marked, DOMPurify and highlight.js scripts the chat renders with, pinned with integrity hashes. |
| `ui/markdown.js` | Model text to sanitized HTML, and the credential scrub that runs first. |
| `ui/export-config.js` | `resolveExportConfig`: whether the export button appears, and its settings. |
| `ui/export-report.js` | The session report that the export button downloads. `ChatUI` imports it with `import()` on the first export, so an app with the export turned off never loads it. |
| `ui/voice-input.js`, `ui/transcriber.js` | Voice input, loaded only when the config names a `transcription_model`. |
| `ui/chat.css` | The chat's styles. |
| `ui/chat-docked.css` | Styles for the chat in a page column (geo-agent's sidebar look), coloured by CSS tokens a host can override, such as `--control-bg`. |

```js
const H = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.10.0';
const [{ Agent, ToolRegistry }, { ChatUI, buildChatPanel, loadChatDeps }] =
    await Promise.all([import(`${H}/src/index.js`), import(`${H}/ui/index.js`)]);

await loadChatDeps();
const registry = new ToolRegistry();
registry.registerLocal(myTool);
const agent = new Agent(config, registry, { clientName: 'my-app/1.0' });
agent.setSystemPrompt(prompt);
const ui = new ChatUI(agent, config, buildChatPanel(document.querySelector('#chat')));
ui.addElement(cardElement);   // show a table or chart a tool made
```

`ChatUI` takes the same config as geo-agent (`llm_models` as set by `applyProxyModelList`, `welcome`, `auto_approve`, `export`, `links`, `transcription_model`) and the same optional map and chart arguments, which only the export uses. The export asks the chart renderer for each chart's figure (`exportFigure(id)`) and, if it has one, `exportQuery(id)`: for a chart that follows the host's settings, its SQL with the current values filled in and those settings as `{ label, value }` pairs, so the report's code and figure agree. A host can override `exportRow()` to put the export button in a row of its own, `footerLinks(links)` to add text links to the chat footer, as glen does for its data sources page, and `appVersion()` to name its own build in the export's "Generated with GLEN" line instead of the harness's tag. `addResultAction(fn)` adds controls under tool results: `fn` gets each result as it is shown (`name`, `args`, `success`, `result`, `sqlQuery`) and returns an element, a list of them, or nothing; glen uses it for the buttons that download a query's rows. The user-provided key mode stores the key, endpoint and model id under geo-agent's `localStorage` names, and a visitor's MCP token beside them, so settings saved in one GLEN app work in the others on the same site.

## Model list

The model service's `GET <llm_endpoint>/models` is the only source of the model list, the default model and each model's settings (SchmidtDSE/glen#542). Apps name no models. `applyProxyModelList(config)` fetches that list and, when it is open-llm-proxy's tier list (it has a `tier`), sets `llm_models` from its entries and `llm_model` to the tier's default. Each model's label, `reasoning_toggle`, sampling and other settings come from the entry's `settings`, and nothing in the app's config overrides them. When the list names a top-level `transcription_model` (open-llm-proxy#210), it becomes the voice-input model, called with the same endpoint and key; a list that names none leaves the config's own `transcription_model` as it is. The config takes the usual OpenAI-compatible shape: `llm_endpoint` and an optional `llm_api_key`. With a key, `/models` and chat requests carry `Authorization: Bearer <key>`; without one they carry no header, so a deployment behind basic auth keeps its saved login (glen#420). While apps move to `llm_endpoint`, a config with only `llm_models` uses the first entry's endpoint and key and ignores the rest, so an app whose nginx checks the bearer against its app token keeps working.

When there is no endpoint, the service cannot be reached, or the answer is not a tier list, `applyProxyModelList` throws a `ModelListError` (`code: 'model-list-unavailable'`) and leaves the config as it was. There is no fallback to a stale list. The host shows the error, or, in the user-provided key mode, offers the user's own models. An `Agent` with no models refuses to send a request and says the model service could not be reached. A host calls it before creating the `Agent`:

```js
try {
    await applyProxyModelList(config);   // resolves to the tier name
} catch (err) {
    if (err.code !== 'model-list-unavailable') throw err;
    // show err.message, or fall back to the user's own key
}
const agent = new Agent(config, registry);
```

`Agent` itself still takes an explicit `llm_models` array, as the benchmark runner and the user-provided key mode build one directly.

In the user-provided key mode (`llm.user_provided`), `buildUserModels(config.llm, loadUserSettings())` builds the list from the key, endpoint and optional model id the user saved in the chat's settings panel. A model id the user names goes first and starts selected; the panel suggests the ids the endpoint's `/models` lists. These are SchmidtDSE/glen#444 and glen#443.

## MCP token for visitors

A static deployment has nowhere to keep a secret, so when its MCP server wants a token, the visitor can enter one in the chat's settings panel. It is saved in their browser and sent as a bearer token to that server only (SchmidtDSE/glen#442). It is offered only where `userTokenApplies(server)` holds: the server is on another origin from the page, and the app gives it no `Authorization` header of its own. A same-origin URL is the deployment's own relay, and a header set by the page there would replace the browser's saved basic-auth credentials (glen#420).

```js
const server = { url: 'https://duckdb-mcp.example.org/mcp', headers: {} };
const offer = userTokenApplies(server);
const mcp = new MCPClient(server.url, offer ? withUserToken(server.headers, loadMcpToken()) : server.headers);
let authFailed = false;
try { await mcp.connect(); } catch (err) { authFailed = isMcpAuthError(err); }

// after the ChatUI exists:
if (offer) ui.enableMcpToken({
    authFailed,
    apply: async (token) => {
        await mcp.setHeaders(withUserToken(server.headers, token));
        await mcp.reconnect();
    },
});
```

With `authFailed` the chat says the data server needs a token and opens the panel. `apply` runs when the visitor saves or clears a token; a host whose tools were never registered because the server refused it at startup can reload the page instead. Whether the server accepts the header from a browser depends on its CORS settings allowing `Authorization` from the app's origin.

## Apps without MCP

An app whose tools all run in the page imports the `./core` entry (`src/core.js`) and the chat module:

```js
const H = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.10.0';
const { Agent, ToolRegistry } = await import(`${H}/src/core.js`);
const { ChatUI } = await import(`${H}/ui/chat-ui.js`);
```

These load nine files: `src/core.js`, `src/agent.js`, `src/tool-registry.js`, `src/llm-models.js`, `src/mcp-token.js`, `ui/chat-ui.js`, `ui/markdown.js`, `ui/export-config.js` and `ui/icons.js`. They load neither the MCP SDK nor the session export. The export button is on by default; such an app sets `"export": false` in its config to drop it, and the export module is then never requested. Voice input still loads on demand from `ui/voice-input.js` and `ui/transcriber.js` when the config names a `transcription_model`. The same app can add MCP tools later by importing `src/mcp-client.js` and passing its tools to `registerRemote`.

## Use

In a browser, import from jsDelivr pinned to a tag. There is no build step.

```js
import { Agent, ToolRegistry, MCPClient } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.10.0/src/index.js';
```

In Node 20 or later, the same files run directly. Install from git (`npm install github:SchmidtDSE/glen-harness#v0.10.0`), as the package is not yet on npm:

```js
import { Agent, ToolRegistry, MCPClient } from 'glen-harness';

const mcp = new MCPClient('https://duckdb-mcp.carlboettiger.info/mcp');
await mcp.connect();

const registry = new ToolRegistry();
registry.registerRemote(mcp.getTools(), mcp);
registry.registerLocal({
    name: 'current_time',
    description: 'Current date and time.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => new Date().toISOString(),
});

const agent = new Agent(
    { llm_models: [{ value: 'my-model', endpoint: 'https://example.org/v1', api_key: '...' }] },
    registry,
    { clientName: 'my-app/1.0' },
);
agent.setSystemPrompt('You answer questions about geospatial data using the tools provided.');
const { response } = await agent.processMessage('How many protected areas are in California?');
```

[`examples/node.js`](examples/node.js) is a runnable version. Without an LLM key it connects to the MCP server and lists the tools.

A tool call waits 30 seconds for its response when the tool is a metadata lookup (`get_schema`, `get_stac_details`, `get_collection`, `browse_stac_catalog`) and 600 seconds otherwise; `new MCPClient(url, headers, { toolTimeoutsMs: { name: ms } })` changes either. When the response does not come, or the connection fails, the client reconnects and tries the call once more, so a lost response to a lookup costs about half a minute rather than ten ([#20](https://github.com/SchmidtDSE/glen-harness/issues/20)). Each call's start and end are logged to the console with the server's URL and the time taken, and each result carries `ms` and `server`, which the session record keeps and the export's session log shows ([#24](https://github.com/SchmidtDSE/glen-harness/issues/24)). Several MCP servers can register in one registry, and each tool call goes to the server that listed the tool. Pass each server's place in the app's configuration as `rank`: when two servers list a tool of the same name, the lower rank keeps it. `clearRemote(client)` drops one server's tools after it reconnects and leaves the others in place.

MCP gives a client no way to ask a server for part of its tool list, so the registry filters instead. `include` registers only the named tools, and `exclude` registers all but those:

```js
registry.registerRemote(duckdb.getTools(), duckdb, null, { rank: 0, exclude: ['browse_stac_catalog'] });
registry.registerRemote(sdm.getTools(), sdm, null, { rank: 1, include: ['fit_sdm'] });
```

An `include` name the server does not list is logged as a warning.

Model settings (`temperature`, `max_tokens`, `prompt_cache`, `reasoning_toggle`, `llm_timeout_seconds`, `max_tool_calls`, and others) are read from the config object, per model first and then globally. They are documented in the geo-agent [configuration guide](https://github.com/boettiger-lab/geo-agent/blob/main/docs/guide/configuration.md).

## Changes from geo-agent

The code is the same as in geo-agent except for two options, so that it no longer names geo-agent:

- `new Agent(config, registry, { clientName })` sets the `X-Client` header sent to trusted proxy hosts. The default is `glen-harness/<tag>`.
- `new MCPClient(url, headers, { clientInfo })` sets the name the client gives in the MCP handshake. The default is `glen-harness`.

Since v0.2.0 it also carries a later geo-agent fix: a model without an `api_key` is sent no `Authorization` header, so a deployment behind basic auth keeps working (SchmidtDSE/glen#420).

Since v0.3.0 it also carries glen's support for several MCP servers in one registry (glen#338), and adds the `include` and `exclude` filters and the `footerLinks` hook that glen needs to move onto the harness.

## Use in GLEN

glen core (`core/` in [SchmidtDSE/glen](https://github.com/SchmidtDSE/glen)) imports the harness from jsDelivr at a release tag and keeps no copy. glen's full app in `app/` still runs its own copies of the agent, registry, MCP client and chat, from which this code was taken. They are to be replaced as that app moves onto glen core and its plugins; the steps are tracked in [glen#441](https://github.com/SchmidtDSE/glen/issues/441).

## Design principles

**Tools come from MCP servers.** A tool server can be written in any language and run anywhere; the harness sees only its tool list. Local tools are kept for controlling the host page, such as the map in geo-agent.

**The transport is stateless Streamable HTTP.** One contract covers a server on a cluster, on the same machine at `localhost`, or on an offline machine. TLS, authentication, network policy and request logs apply to it, and a stateless server scales as interchangeable copies. Long jobs return an id that a second tool checks.

**The model gets as few capabilities as the task needs.** It can act only through the tools it is given. We prefer narrow tools over a domain (run a query, edit a simulation) to general file or shell access, and each tool server sees only its own data.

**The harness runs inside the browser sandbox.** A page can reach only the endpoints it is allowed to, and a Content-Security-Policy can list exactly the model endpoint and the MCP servers. Files and chats stay in the browser, apart from what is sent to the model endpoint and the tool servers.

**Any OpenAI-compatible model endpoint works,** hosted or local.

**There is no build step and nothing to resolve at runtime.** The harness is plain files served at a pinned version. Its one dependency, the MCP SDK, is a single committed file that CI rebuilds and compares. Development dependencies are installed without running their install scripts.

**The same files run in the browser and in Node,** so tests, benchmarks and command-line tools exercise the code that users run. The chat interface in `ui/` is the one part that needs a browser, and its tests run under jsdom.

**Apps share one chat.** Every GLEN app that has a chat uses the same interface, so a stop button, a fix or a new control reaches all of them.

## Development

```bash
corepack pnpm install
pnpm test
pnpm run build:vendor   # only when bumping @modelcontextprotocol/sdk; see src/vendor/README.md
```

Development dependencies are installed with pnpm, pinned in `package.json`. The settings in `pnpm-workspace.yaml` stop dependencies from running install scripts and hold back any version less than a week old.

CI runs the tests and checks that `src/vendor/mcp-sdk.js` matches a fresh build.

## License

Apache-2.0. See [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).

Since v0.4.0 it also carries glen's model list from the proxy and model id for user-provided keys (glen#443, glen#444), and the MCP token for visitors (glen#442), with `MCPClient#setHeaders` to change a token without a new client.
