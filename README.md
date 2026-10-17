# glen-harness

The agent harness behind GLEN apps: the loop that sends a conversation and a set of tools to a language model, runs the tool calls the model makes, and returns the results to the model until it answers. It is written in plain JavaScript (ES modules) and runs unchanged in a web browser and in Node.

This is a draft. The code was extracted from [boettiger-lab/geo-agent](https://github.com/boettiger-lab/geo-agent) at commit `f0b144f`, where it runs in production in every GLEN map app. Issue numbers in code comments refer to geo-agent unless another repository is named.

## Modules

| Module | What it does |
|---|---|
| `src/agent.js` | `Agent`: the tool-use loop against any OpenAI-compatible Chat Completions endpoint. Handles retries and timeouts, user abort, approval of tool calls, checkpoints after a set number of tool rounds, output-length limits, reasoning/thinking controls, prompt-cache breakpoints, and recovery of tool calls that models emit as text in non-standard dialects. |
| `src/tool-registry.js` | `ToolRegistry`: one dispatch for local tools (functions in the same process, such as map controls) and remote tools (on an MCP server). Converts tool schemas to the OpenAI function-calling format and memoizes idempotent metadata reads. |
| `src/mcp-client.js` | `MCPClient`: connection to an MCP server, with lazy reconnect. Streamable HTTP by default; pass `{ transport: () => … }` for any other MCP transport. |
| `src/post-message-transport.js` | `PostMessageTransport`: MCP over `postMessage`, for a server running in a Web Worker in the same page. |
| `src/vendor/mcp-sdk.js` | The MCP SDK, pre-bundled so that no import map or third-party module host is needed. See [`src/vendor/README.md`](src/vendor/README.md). |

The harness has no DOM code and no dependencies beyond the vendored MCP SDK. A host application connects its UI through callbacks on the `Agent` (`onToolProposal`, `onToolResults`, `onResponse`, `onCheckpoint`, and others).

## Use

In a browser, import from jsDelivr pinned to a tag. There is no build step. (jsDelivr serves only public repositories, and no tag has been cut yet.)

```js
import { Agent, ToolRegistry, MCPClient } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@v0.1.0/src/index.js';
```

In Node 20 or later, the same files run directly. Install from git (`npm install github:SchmidtDSE/glen-harness#v0.1.0`), as the package is not yet on npm:

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

Model settings (`temperature`, `max_tokens`, `prompt_cache`, `reasoning_toggle`, `llm_timeout_seconds`, `max_tool_calls`, and others) are read from the config object, per model first and then globally. They are documented in the geo-agent [configuration guide](https://github.com/boettiger-lab/geo-agent/blob/main/docs/guide/configuration.md).

## Changes from geo-agent

The code is the same as in geo-agent except for two options, so that it no longer names geo-agent:

- `new Agent(config, registry, { clientName })` sets the `X-Client` header sent to trusted proxy hosts. The default is `glen-harness/<tag>`.
- `new MCPClient(url, headers, { clientInfo })` sets the name the client gives in the MCP handshake. The default is `glen-harness`.

## Linking from geo-agent

We propose that geo-agent vendor a pinned copy of `src/` into `app/vendor/glen-harness/` and keep `app/agent.js`, `app/tool-registry.js` and `app/mcp-client.js` as thin modules that pass geo-agent's name to the harness:

```js
// geo-agent/app/agent.js
import { Agent as HarnessAgent } from './vendor/glen-harness/agent.js';

const APP_VERSION = import.meta.url.match(/geo-agent@([^/]+)/)?.[1] || 'dev';

export class Agent extends HarnessAgent {
    constructor(config, toolRegistry) {
        super(config, toolRegistry, { clientName: `geo-agent/${APP_VERSION}` });
    }
}
```

This follows the pattern geo-agent already uses for the MCP SDK (geo-agent#343). Every module still loads from the jsDelivr path the app is pinned to, no new host enters the page load, and geo-agent's tests resolve the files by relative path. A CI check that the vendored copy matches the pinned glen-harness tag would replace the current check on `mcp-sdk.js`. We tested this layout in a geo-agent worktree: all 975 geo-agent tests pass with the three modules replaced by thin modules over this harness.

Importing directly from a jsDelivr URL also works in the browser, but Node and vitest cannot resolve `https:` imports, so geo-agent's tests would need an alias to a second copy installed from npm or git.

## Design principles

**Tools come from MCP servers.** A tool server can be written in any language and run anywhere; the harness sees only its tool list. Local tools are kept for controlling the host page, such as the map in geo-agent.

**The transport is stateless Streamable HTTP.** One contract covers a server on a cluster, on the same machine at `localhost`, or on an offline machine. TLS, authentication, network policy and request logs apply to it, and a stateless server scales as interchangeable copies. Long jobs return an id that a second tool checks.

**The model gets as few capabilities as the task needs.** It can act only through the tools it is given. We prefer narrow tools over a domain (run a query, edit a simulation) to general file or shell access, and each tool server sees only its own data.

**The harness runs inside the browser sandbox.** A page can reach only the endpoints it is allowed to, and a Content-Security-Policy can list exactly the model endpoint and the MCP servers. Files and chats stay in the browser, apart from what is sent to the model endpoint and the tool servers.

**Any OpenAI-compatible model endpoint works,** hosted or local.

**There is no build step and nothing to resolve at runtime.** The harness is plain files served at a pinned version. Its one dependency, the MCP SDK, is a single committed file that CI rebuilds and compares. Development dependencies are installed without running their install scripts.

**The same files run in the browser and in Node,** so tests, benchmarks and command-line tools exercise the code that users run.

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
