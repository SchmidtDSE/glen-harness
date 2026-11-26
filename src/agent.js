/**
 * Agent - LLM orchestration loop
 * 
 * Pure logic, no DOM manipulation. Communicates via event callbacks.
 * 
 * Implements the agentic tool-use loop:
 *   1. Send messages + tools to LLM
 *   2. If LLM returns tool_calls → emit proposal → wait for approval → execute → loop
 *   3. If LLM returns text → emit response → done
 * 
 * Supports multiple OpenAI-compatible LLM backends.
 * Handles embedded tool calls (XML tags) from models that don't use structured tool_calls.
 *
 * Issue numbers (#NNN) refer to boettiger-lab/geo-agent, where this code was
 * developed before it moved here, unless another repo is named.
 */

import { isFailedToolResult } from './tool-registry.js';

// The pinned ref the harness was loaded from lives in the module URL itself
// (…/glen-harness@v0.1.0/src/agent.js), so it identifies the exact build with
// no build step. Falls back to 'dev' for local/headless runs (a file:// URL).
// Used only for the default X-Client log-attribution header (geo-agent#254);
// an app names itself with the `clientName` option. See `_clientHeaders`.
const HARNESS_VERSION = import.meta.url.match(/glen-harness@([^/]+)/)?.[1] || 'dev';

// How each LLM response ended — `finish_reason`, OpenRouter's
// `native_finish_reason`, and `usage.completion_tokens` — keyed by its message
// object. Kept off the message itself because messages go back upstream as
// history.
const RESPONSE_END = new WeakMap();

// The user message that opened each turn, so history is cut at turn
// boundaries rather than at the harness's in-turn nudges or a host's notes,
// which are also user messages.
const TURN_OPENERS = new WeakSet();

// A sentence that announces work the model is about to do (glen-harness#26):
// "Let me (also) verify…", "I'll now run…", "Next, I'll check…". And phrases
// that make such a sentence an offer to the user instead.
// Computing words are left out: "Let me calculate: 26.5 / 101.5 = 26.1%"
// does the arithmetic in place, and so does "Let's compute …".
const ACTIONS = '(?:verify|check|confirm|double[- ]check|validate|query|look\\s+up|look\\s+into|'
    + 're-?run|run|fetch|pull|search|investigate|test)';
const ANNOUNCE = new RegExp(
    "\\b(?:let me|i(?:'ll| will| am going to|'m going to)|next,? i(?:'ll| will))\\s+"
        + `(?:(?:also|now|quickly|first|just|then|still|go\\s+ahead\\s+and)\\s+)*${ACTIONS}\\b`,
    'i',
);
const OFFER = /\b(?:want me to|would you like|should i|shall i|if you(?:'d| would)? like|if you want|if needed|i can|i could|happy to|let me know|can also|tell me|say which|just say|and i(?:'ll| will))\b/i;

// Tool calls recovered from a reply's text (#288, #295), keyed by that reply.
// Within its turn the reply goes upstream as the model wrote it. When the
// turn is kept as history, the reply is rewritten with these calls as its
// `tool_calls`, so the tool results after it answer a call a strict provider
// can see.
const RECOVERED_CALLS = new WeakMap();

// Messages the harness adds within a turn to steer the model (a re-prompt
// after an unparseable call or a repeated failure, the checkpoint request).
// They are left out when the turn is kept as history.
const HARNESS_PROMPTS = new WeakSet();
const harnessPrompt = (content) => {
    const m = { role: 'user', content };
    HARNESS_PROMPTS.add(m);
    return m;
};

// A finished turn is kept as history in a shorter form, once, when it ends
// (glen-harness#21): its tool calls with their arguments, each result cut to
// HISTORY_RESULT_CHARS, and the text the model wrote. Arguments longer than
// HISTORY_ARGS_CHARS, such as a drawn polygon, are replaced with a note.
const HISTORY_RESULT_CHARS = 1000;
const HISTORY_ARGS_CHARS = 4000;

// Size of the history sent with each turn, in characters of message JSON.
// Past it the oldest turns are dropped. Override with `history_budget_chars`,
// per model or globally.
const HISTORY_BUDGET_CHARS = 60000;
// History over budget is brought down to this share of it, so turns are
// dropped now and then, not on every turn, which would change the cached
// prefix each time.
const HISTORY_TARGET_SHARE = 0.75;

export class Agent {
    /**
     * @param {Object} config
     * @param {import('./tool-registry.js').ToolRegistry} toolRegistry
     * @param {Object} [options]
     * @param {string} [options.clientName] - The X-Client value sent to trusted
     *   proxy hosts, e.g. `geo-agent/v3.14.0`. Defaults to `glen-harness/<ref>`.
     */
    constructor(config, toolRegistry, options = {}) {
        this.config = config;
        this.clientName = options.clientName ?? `glen-harness/${HARNESS_VERSION}`;
        this.toolRegistry = toolRegistry;
        this.systemPrompt = '';
        this.messages = [];
        this.selectedModel = config.llm_model || config.llm_models?.[0]?.value || null;
        // Runtime override for model thinking/reasoning, set by the host UI's toggle.
        // null = no override (fall back to config default, else omit → model default);
        // true/false = user asked for reasoning on/off for subsequent turns. Reset to
        // null on model switch so each model starts from its own configured default.
        this.reasoningOverride = null;
        // Runtime reasoning level for a model that takes one (#23), set by the
        // host UI's level selector; one of the model's `reasoning_efforts`, or
        // null for the configured default. Reset on model switch.
        this.reasoningEffortOverride = null;
        // Checkpoint thresholds: how many *remote* tool-call rounds before the
        // agent pauses to report progress and ask to continue. Auto-approve uses
        // the tighter value (the checkpoint is the user's periodic gate); manual
        // mode uses a high value since per-call approval is already the guard.
        // null/0 in either disables the checkpoint for that mode.
        this.maxToolCalls = config.max_tool_calls ?? 15;
        this.maxToolCallsManual = config.max_tool_calls_manual ?? 100;
        // In-flight turn state preserved across user messages when a turn pauses
        // at a checkpoint. null when no turn is suspended.
        this.suspendedTurn = null;
        this.autoApprove = config.auto_approve ?? true;
        this.sessionId = crypto.randomUUID();
        this.abortController = null;

        // Event callbacks (set by the host app's UI, e.g. geo-agent's chat-ui.js)
        this.onThinkingStart = () => { };
        this.onThinkingEnd = () => { };
        this.onReasoning = () => { };
        this.onToolProposal = async () => ({ approved: true }); // auto-approve by default
        this.onToolExecuting = () => { };
        this.onToolResults = () => { };
        this.onResponse = () => { };
        this.onError = () => { };
        this.onRetry = () => { };
        // Waits before retrying a 5xx or network error; one retry per entry (#437).
        this.retryDelaysMs = [15000, 60000];
        this.onCheckpoint = () => { };
    }

    /**
     * Set the system prompt (called after catalog is built).
     */
    setSystemPrompt(prompt) {
        this.systemPrompt = prompt;
    }

    /**
     * Set the active model.
     */
    setModel(modelValue) {
        this.selectedModel = modelValue;
        // Clear any per-conversation reasoning override so the newly-selected
        // model resolves from its own configured default.
        this.reasoningOverride = null;
        this.reasoningEffortOverride = null;
    }

    /**
     * Get the config for the currently selected model: the entry in
     * `llm_models` whose `value` matches, else the first entry, else null when
     * no model is configured.
     */
    getModelConfig() {
        const found = this.config.llm_models?.find(m => m.value === this.selectedModel);
        return found || this.config.llm_models?.[0] || null;
    }

    /**
     * The active remote-round checkpoint threshold for the current mode.
     * 0 or null means "no checkpoint" for that mode.
     */
    activeThreshold() {
        return this.autoApprove ? this.maxToolCalls : this.maxToolCallsManual;
    }

    /**
     * Abort the in-flight turn, if any. Cancels the current LLM fetch
     * and causes the agent loop to bail out at its next await point.
     */
    abort() {
        this.abortController?.abort();
    }

    /**
     * Process a user message through the full agentic loop.
     *
     * Input arrives as plain text; voice or other input is the host app's job.
     *
     * @param {string} userMessage
     * @returns {Promise<{response: string, sqlQueries: string[], cancelled: boolean}>}
     */
    async processMessage(userMessage) {
        // Track SQL queries for this turn. When resuming a suspended turn, carry
        // forward the queries already collected before the pause.
        const resuming = this.suspendedTurn;
        const sqlQueries = resuming ? resuming.sqlQueries : [];

        // Per-turn AbortController — triggered by abort() (user-pressed Stop)
        // or by the 5-min timeout inside callLLM(). Either path rejects any
        // outstanding await via the abortPromise race below.
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const abortPromise = new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        });
        // Silence "unhandled rejection" if abort fires while no withAbort() race is active
        // (e.g. user stops during the LLM fetch, which owns the signal directly).
        abortPromise.catch(() => {});
        const withAbort = (p) => Promise.race([p, abortPromise]);

        const tools = this.toolRegistry.getToolsForLLM();
        const modelConfig = this.getModelConfig();
        if (!modelConfig?.endpoint) {
            // No model list (the model service could not be reached, or a
            // bring-your-own-key user has not saved a key yet). Say so rather
            // than send a request to a made-up endpoint (glen#542).
            throw new Error('No model is available: the model service could not be reached. '
                + 'Reload the page to try again.');
        }

        const opener = { role: 'user', content: userMessage };
        this.messages.push(opener);

        // The turn's working messages, where in them the turn begins, and the
        // entries it has put into this.messages so far. When the turn ends,
        // those entries are replaced with its whole trace (_keepTurn).
        let turn;
        if (resuming) {
            // Resume the paused turn: reuse its full tool-call history and append
            // the new user message (a canned "continue" or a steering instruction).
            // Do NOT rebuild from this.messages — that would discard the in-flight
            // work and restart from scratch.
            this.suspendedTurn = null;
            turn = {
                turnMessages: resuming.turnMessages,
                sqlQueries,
                turnStart: resuming.turnStart,
                ownEntries: [...(resuming.ownEntries ?? []), opener],
            };
            turn.turnMessages.push(opener);
        } else {
            TURN_OPENERS.add(opener);
            this._fitHistory(modelConfig);
            const turnMessages = [
                { role: 'system', content: this.systemPrompt },
                ...this.messages,
            ];
            turn = { turnMessages, sqlQueries, turnStart: turnMessages.length - 1, ownEntries: [opener] };
        }
        const { turnMessages } = turn;
        let endpoint = modelConfig.endpoint;
        if (!endpoint.endsWith('/chat/completions')) {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }

        let iterations = 0;
        // Consecutive local-only tool rounds. Local map tools never increment
        // `iterations` (they're cheap and never gated), so a model stuck
        // re-issuing a local tool — e.g. set_filter failing — would loop forever
        // with no checkpoint to stop it (#243). This counter bounds that.
        let localOnlyStreak = 0;
        // Malformed-tool-call recovery attempts this turn (#288). When the model
        // emits something that *looks* like a tool call but we can't parse it, we
        // re-prompt it to re-emit a well-formed call instead of silently treating
        // the garbage as a final answer. Bounded so a model that simply cannot
        // produce a parseable call falls through to its text rather than looping.
        let parseRetries = 0;
        const MAX_PARSE_RETRIES = 2;
        // Repeated-failure short-circuit (#313). A model re-issuing the
        // byte-identical tool call(s) that just failed is not making progress.
        // We nudge it once, then checkpoint — rather than burning the whole
        // localOnlyStreak cap on ~15 identical failures (observed live: glm-5.2
        // looping a corrupted add_hex_tile_layer call). Tracks the signature of
        // the last all-failed round and how many times it has repeated since.
        let repeatedFailureStreak = 0;
        let lastFailedRoundSig = null;
        // Repeated-success short-circuit (glen-harness#19). A model that
        // re-issues the byte-identical call(s) that just succeeded is not making
        // progress either: the result is already in its context. The first
        // repeat is not run; the model is told to use the earlier result. A
        // second repeat checkpoints.
        let lastSucceededRoundSig = null;
        let repeatedSuccessStreak = 0;
        // Empty-reply retries this turn (glen-harness#25): a reply with no text
        // and no tool call, usually reasoning that broke off, is asked for again
        // once before the turn gives up.
        let emptyRetries = 0;
        const MAX_EMPTY_RETRIES = 1;
        // Announced-but-not-run retries this turn (glen-harness#26): a final
        // answer that says "Let me also verify …" with no tool call is asked
        // once to run the check or answer without announcing it.
        let announceRetries = 0;
        const MAX_ANNOUNCE_RETRIES = 1;

        try {
        while (true) {
            const threshold = this.activeThreshold();
            if (threshold && iterations >= threshold) {
                return await this._checkpoint(endpoint, modelConfig, turn, iterations);
            }
            // Runaway guard: a turn that does `threshold` local-only rounds in a row
            // (with no remote round and no final answer) is stuck looping, not making
            // progress. Checkpoint it like any other cap. A remote round resets the
            // streak, so legitimately tool-heavy turns are unaffected.
            if (threshold && localOnlyStreak >= threshold) {
                return await this._checkpoint(endpoint, modelConfig, turn, iterations);
            }
            this.onThinkingStart();

            // Call LLM — no withAbort wrapper: the shared AbortController's
            // signal already reaches fetch, and wrapping would orphan the
            // fetch's own AbortError rejection.
            let message;
            try {
                message = await this.callLLM(endpoint, modelConfig, turnMessages, tools);
            } finally {
                this.onThinkingEnd();
            }
            // Surface reasoning before pushing back into the loop. Strips
            // <think> blocks from content and drops reasoning_content from
            // the message so it isn't re-sent on subsequent turns.
            const reasoning = this.extractReasoning(message);
            if (reasoning) this.onReasoning(reasoning, iterations);

            // Cut off at the output limit (#387): the configured max_tokens, or
            // the model's own ceiling when none is set. Its tool calls can't be
            // trusted — the last one's arguments may be half-written, and a
            // runaway has emitted thousands of identical calls (18,579 in one
            // response, open-llm-proxy#150) — so none run. Text that did arrive
            // is still shown, marked as cut off.
            if (this._hitOutputLimit(message, modelConfig)) {
                return this._lengthLimited(message, modelConfig, turn);
            }

            // Canonicalize native tool-call arguments before they enter history
            // (#288, failure mode 2): a malformed `arguments` string (e.g. an
            // extra trailing brace) is parseable-for-execution below but, left
            // verbatim in the assistant message, poisons the *next* upstream
            // request (400 Extra data). Normalize once here so history is always
            // valid JSON regardless of what the model emitted.
            this.normalizeToolCallArguments(message);
            turnMessages.push(message);

            // Check for tool calls
            const toolCalls = message.tool_calls || [];
            const embeddedCalls = toolCalls.length === 0 ? this.parseEmbeddedToolCalls(message.content) : [];

            if (toolCalls.length > 0 || embeddedCalls.length > 0) {
                // A parseable call ends any malformed-call streak — a single glitch
                // over a long turn shouldn't accumulate toward the recovery cap.
                parseRetries = 0;
                const calls = toolCalls.length > 0 ? toolCalls : this.syntheticToolCalls(embeddedCalls);
                if (toolCalls.length === 0) RECOVERED_CALLS.set(message, calls);

                const roundSig = JSON.stringify(calls.map(c => [c.function?.name, c.function?.arguments]));
                repeatedSuccessStreak = roundSig === lastSucceededRoundSig ? repeatedSuccessStreak + 1 : 0;
                if (repeatedSuccessStreak === 1) {
                    for (const tc of calls) {
                        turnMessages.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: `You already called ${tc.function?.name} with these arguments, and the `
                                + 'result is in the earlier tool message. It was not run again. Use that '
                                + 'result and continue, or answer the user.',
                        });
                    }
                    continue;
                }
                if (repeatedSuccessStreak >= 2) {
                    return await this._checkpoint(endpoint, modelConfig, turn, iterations);
                }

                // Classify: are all calls local (auto-approve) or mixed?
                const allLocal = calls.every(tc => this.toolRegistry.isLocal(tc.function.name));

                // Only remote (MCP/SQL) rounds count toward the checkpoint
                // threshold — local map tools are cheap and never gated. But a
                // remote round breaks a local-only streak, while a local-only
                // round extends it (the runaway guard above).
                if (!allLocal) {
                    iterations++;
                    localOnlyStreak = 0;
                } else {
                    localOnlyStreak++;
                }

                // Strip recovered tool-call text from content before displaying to user
                const displayContent = message.content
                    ? this.stripEmbeddedCalls(message.content)
                    : null;

                let approved = true;
                if (!allLocal && !this.autoApprove) {
                    // Show proposal and wait for approval
                    const result = await withAbort(this.onToolProposal(calls, displayContent, iterations));
                    approved = result.approved;
                } else {
                    // Auto-approve: local tools always, remote tools when autoApprove is on
                    this.onToolProposal(calls, displayContent, iterations, true /* autoApproved */);
                }

                if (!approved) {
                    return { response: null, sqlQueries, cancelled: true };
                }

                // Signal that tools are now executing
                this.onToolExecuting(calls);

                // Execute all tool calls
                const results = [];
                for (const tc of calls) {
                    let args;
                    try {
                        args = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments;
                    } catch {
                        const err = 'Error: Invalid JSON in tool arguments';
                        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: err });
                        results.push({ name: tc.function.name, result: err, source: 'error' });
                        continue;
                    }

                    const execResult = await withAbort(this.toolRegistry.execute(tc.function.name, args));
                    // The call's arguments ride along for the host's result
                    // actions (ChatUI.addResultAction), such as a download
                    // that re-runs a query with the same endpoint.
                    results.push({ ...execResult, args });

                    // Track SQL queries
                    if (execResult.sqlQuery) sqlQueries.push(execResult.sqlQuery);

                    // Add to conversation — cap to prevent SQL results from consuming
                    // the remaining context budget mid-turn. 16K fits current STAC
                    // schema-discovery payloads (~8–10 KB at largest) with headroom.
                    const TOOL_RESULT_CAP = 16000;
                    const resultContent = execResult.result?.length > TOOL_RESULT_CAP
                        ? execResult.result.substring(0, TOOL_RESULT_CAP) + '\n... (truncated)'
                        : execResult.result;
                    turnMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: resultContent,
                    });
                }

                // Show results
                this.onToolResults(results, iterations);

                // Repeated-failure short-circuit (#313): if this round re-issued
                // the identical call(s) that just failed, and every call failed
                // again, the model is stuck. Steer it once; if it still repeats,
                // checkpoint instead of looping to the localOnlyStreak cap.
                const roundFailed = results.length > 0 && results.every(r => this._isFailedResult(r));
                repeatedFailureStreak = (roundFailed && roundSig === lastFailedRoundSig)
                    ? repeatedFailureStreak + 1
                    : 0;
                lastFailedRoundSig = roundFailed ? roundSig : null;
                lastSucceededRoundSig = roundFailed ? null : roundSig;
                if (repeatedFailureStreak === 1) {
                    const errText = (results.find(r => this._isFailedResult(r))?.result || '').slice(0, 300);
                    turnMessages.push(harnessPrompt(
                        'That tool call just failed with the same error as the previous attempt'
                            + (errText ? `:\n${errText}\n` : '. ')
                            + 'Repeating the identical call will not help. Call it differently, use a '
                            + 'different tool, or reply to the user in plain text explaining the problem.',
                    ));
                    continue;
                }
                if (repeatedFailureStreak >= 2) {
                    return await this._checkpoint(endpoint, modelConfig, turn, iterations);
                }

                // Continue loop — LLM will see the results
                continue;
            }

            const content = message.content || '';

            // Malformed tool-call recovery (#288, failure modes 1 & 3): we got
            // neither structured tool_calls nor a parseable embedded call, yet the
            // content looks like the model *tried* to call a tool (wrong wrapper,
            // mismatched close tag, or invalid inner JSON). Rather than silently
            // returning the garbage as the final answer, nudge it to re-emit a
            // well-formed call and continue the loop. Bounded by MAX_PARSE_RETRIES
            // so a model that can't recover degrades to its text instead of looping.
            if (parseRetries < MAX_PARSE_RETRIES && this.looksLikeAttemptedToolCall(content)) {
                parseRetries++;
                turnMessages.push(harnessPrompt(
                    'That looked like a tool call but could not be parsed. Re-emit it as a single '
                        + 'well-formed call: <tool_call>{"name": "<tool_name>", "arguments": {…}}</tool_call> '
                        + 'with valid JSON and a matching </tool_call> tag. If you already have your answer, '
                        + 'reply in plain text instead.',
                ));
                continue;
            }

            // No tool calls — final response
            if (!content.trim() && emptyRetries < MAX_EMPTY_RETRIES) {
                // Drop the empty reply, since some providers reject an empty
                // assistant message, and ask again.
                emptyRetries++;
                turnMessages.pop();
                turnMessages.push(harnessPrompt(
                    'Your last reply was empty. Continue from where you were: call the tool you '
                        + 'need, or give your answer to the user.',
                ));
                continue;
            }
            if (!content.trim()) {
                return {
                    response: 'I received your question but had trouble generating a response. Please try rephrasing.',
                    sqlQueries,
                    cancelled: false
                };
            }

            // A final answer that announces work it did not do (#26), such as
            // "Let me also verify there's nothing closer…" with no tool call.
            // Ask once to do it or to answer without announcing it. The
            // announcing reply and the prompt are left out of history.
            const announced = announceRetries < MAX_ANNOUNCE_RETRIES ? this.announcedCheck(content) : null;
            if (announced) {
                announceRetries++;
                console.info(`[Agent] Final answer announces a check with no tool call: "${announced}"`);
                turnMessages.push(harnessPrompt(
                    `Your reply says "${announced}", but you called no tool, so that has not happened. `
                        + 'Call the tool now to do it, or give your final answer without saying you will '
                        + 'do something you have not done.',
                ));
                continue;
            }

            // Keep the whole turn, tool calls and results included, as history
            // (glen-harness#21). The reply is already the last of turnMessages.
            this._keepTurn(turn);
            this.suspendedTurn = null;

            return { response: content, sqlQueries, cancelled: false };
        }
        } catch (err) {
            if (err.name === 'AbortError') {
                return { response: null, sqlQueries, cancelled: true };
            }
            throw err;
        }
    }

    /**
     * End a turn whose response stopped at the output limit. A text answer is
     * returned with a note that it was cut off; a response that was cut off
     * mid tool call, or before any text (reasoning ran out the budget), throws
     * a readable error instead, so nothing half-formed runs or enters history.
     */
    _lengthLimited(message, modelConfig, turn) {
        const { sqlQueries } = turn;
        const limit = this._samplingParams(modelConfig).max_tokens;
        const where = limit
            ? `the response limit (max_tokens: ${limit})`
            : "the model's maximum response length";
        const hadCalls = (message.tool_calls || []).length > 0
            || this.parseEmbeddedToolCalls(message.content || '').length > 0;
        const text = (message.content || '').trim();

        if (text && !hadCalls) {
            const note = `*(This answer was cut off at ${where}.${limit ? ' Raise max_tokens for this model to allow longer answers.' : ''})*`;
            const response = `${text}\n\n${note}`;
            turn.turnMessages.push({ role: 'assistant', content: response });
            this._keepTurn(turn);
            this.suspendedTurn = null;
            return { response, sqlQueries, cancelled: false, truncated: true };
        }

        const what = hadCalls ? 'while writing a tool call, so the call was not run'
            : 'before it produced an answer';
        const err = new Error(`The model's response hit ${where} ${what}. `
            + (limit ? 'Try again, or raise max_tokens for this model.' : 'Try again, or choose a different model.'));
        err.lengthLimited = true;
        throw err;
    }

    /**
     * Pause the turn at a checkpoint: make one no-tools LLM call to produce a
     * human-readable progress report, persist the in-flight turn so the next
     * user message resumes it, and emit onCheckpoint. Returns a result the UI
     * renders as a checkpoint (summary + Continue), not an error.
     */
    async _checkpoint(endpoint, modelConfig, turn, iterations) {
        const { turnMessages, sqlQueries } = turn;
        const fallbackSummary = `I've run ${iterations} data queries so far and paused to check in. `
            + `Let me know if you'd like me to continue.`;

        turnMessages.push(harnessPrompt(
            `You have reached a checkpoint after ${iterations} data ${iterations === 1 ? 'query' : 'queries'}. `
                + `Summarize for the user what you have done so far, the key findings, and what remains to be done. `
                + `Then offer to continue.`,
        ));

        let summary = '';
        try {
            const msg = await this.callLLM(endpoint, modelConfig, turnMessages, [] /* no tools → tool_choice none */);
            summary = (msg.content || '').trim();
            turnMessages.push(msg);
        } catch (err) {
            if (err.name === 'AbortError') {
                // User stopped during the summary call. The completed tool work
                // is still valuable — preserve it (minus the checkpoint
                // instruction we just appended) so "continue" resumes the
                // investigation rather than discarding the remote rounds.
                turnMessages.pop();
                this.suspendedTurn = turn;
                return { response: null, sqlQueries, cancelled: true };
            }
            summary = fallbackSummary;
        }
        if (!summary) {
            summary = fallbackSummary;
        }

        // Persist the live turn so the next message resumes it instead of
        // rebuilding from scratch. Record the summary in cross-turn history;
        // _keepTurn replaces it with the full trace once the turn finishes.
        this.suspendedTurn = turn;
        const summaryEntry = { role: 'assistant', content: summary };
        this.messages.push(summaryEntry);
        turn.ownEntries.push(summaryEntry);

        this.onCheckpoint(summary, iterations);
        return { response: summary, sqlQueries, checkpoint: true, cancelled: false };
    }

    /**
     * Resolve sampling params (temperature, top_p, seed, max_tokens) for the
     * outgoing chat-completion payload. Each is read per-model first, then falls back
     * to a global config default. Per-model `null` opts back out of a value
     * (omits the key) even when a global default exists.
     *
     * `temperature` additionally defaults to 0 when nothing is configured:
     * factual/analyst use is the common case, and the harness talks to many
     * OpenAI-compatible endpoints (NRP proxy, OpenRouter, user-supplied keys)
     * whose own defaults vary (0.7 and up) — so we pin a reproducible value
     * client-side rather than inheriting whatever the endpoint happens to use.
     * `top_p`/`seed` have no sensible universal default, so they stay omitted.
     *
     * `max_tokens` (#387) has no default either: unset stays unset. Setting it
     * bounds a runaway generation (models have run 30+ minutes to a 131k
     * ceiling, open-llm-proxy#150) and stops OpenRouter reserving credit for a
     * model's full output ceiling, which 402s a modest balance (#386). A
     * generated config.json can carry it as a string, so it is coerced; anything
     * but a positive integer is dropped with a warning rather than sent.
     */
    _samplingParams(modelConfig) {
        const defaults = { temperature: 0 };
        const params = {};
        for (const key of ['temperature', 'top_p', 'seed', 'max_tokens']) {
            // Per-model wins; `null` there is an explicit opt-out (skip the key).
            // Otherwise fall back to global config, then to the built-in default.
            let value = key in (modelConfig ?? {})
                ? modelConfig[key]
                : this.config[key] ?? defaults[key];
            if (key === 'max_tokens' && value !== undefined && value !== null) {
                // Numbers and numeric strings only: Number(true) is 1, which
                // would send a one-token cap.
                const n = typeof value === 'number' ? value
                    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
                if (Number.isInteger(n) && n > 0) value = n;
                else {
                    console.warn(`[Agent] Ignoring max_tokens ${JSON.stringify(value)}: expected a positive integer.`);
                    value = undefined;
                }
            }
            if (value !== undefined && value !== null) params[key] = value;
        }
        return params;
    }

    /**
     * Whether a response stopped at the output limit (#387): the max_tokens we
     * sent, or the model's own ceiling. `finish_reason` alone is not enough.
     * GLM-5.2 via OpenRouter reports `tool_calls` for a tool call cut off
     * mid-arguments (invalid JSON), with only `native_finish_reason: "length"`
     * and a completion count equal to the cap to show it (verified live,
     * 2026-10-06). So any of the three counts.
     */
    _hitOutputLimit(message, modelConfig) {
        const end = RESPONSE_END.get(message);
        if (!end) return false;
        if (end.finishReason === 'length' || end.nativeFinishReason === 'length') return true;
        const cap = this._samplingParams(modelConfig).max_tokens;
        return !!cap && typeof end.completionTokens === 'number' && end.completionTokens >= cap;
    }

    /**
     * Whether the reasoning on/off toggle should be *offered* for a model.
     * Capability is opt-in per deployment: `reasoning_toggle: true` per-model,
     * else the top-level global. Off (absent) by default — most models/apps
     * don't expose it. Consumed by chat-ui.js to decide whether to render the
     * toggle. Resolved per-model first, then global (mirrors `_samplingParams`).
     */
    _reasoningCapable(modelConfig) {
        const v = ('reasoning_toggle' in (modelConfig ?? {}))
            ? modelConfig.reasoning_toggle
            : this.config?.reasoning_toggle;
        return v === true;
    }

    /**
     * The configured default reasoning state (per-model first, then global).
     * Returns a boolean when set, or `undefined` when unconfigured — in which
     * case we emit nothing and let the model/proxy use its own default.
     */
    _reasoningDefault(modelConfig) {
        const v = ('reasoning_default' in (modelConfig ?? {}))
            ? modelConfig.reasoning_default
            : this.config?.reasoning_default;
        return typeof v === 'boolean' ? v : undefined;
    }

    /**
     * Resolve the thinking-control payload for a turn. Emits `reasoning_effort`
     * when the model has a level (see reasoningEffort), and `enable_thinking`
     * (a normalized flag the open-llm-proxy maps to the correct per-backend
     * chat-template knob) only when this model participates — i.e. the deployer
     * enabled the toggle or set a default. Otherwise the key is omitted so the
     * model's own default is untouched (no behavior change by default).
     *
     * Value precedence: per-conversation user override (the UI toggle) wins,
     * then the configured default, then — for a toggle-capable model — `true`.
     * This mirrors chat-ui's `reasoningState()` exactly, so what the 🧠 toggle
     * shows and what we send can never disagree. See #283.
     */
    _thinkingParams(modelConfig) {
        const capable = this._reasoningCapable(modelConfig);
        const dflt = this._reasoningDefault(modelConfig);
        const effort = this.reasoningEffort(modelConfig);
        const out = effort ? { reasoning_effort: effort } : {};
        // Untouched unless the deployer opted this model in somehow.
        if (!capable && dflt === undefined) return out;
        let value;
        if (typeof this.reasoningOverride === 'boolean') value = this.reasoningOverride;
        // A level the user picked also decides on/off for a model that takes
        // both, so the two fields never disagree: 'none' is off.
        else if (this.reasoningEffortOverride && effort) value = effort !== 'none';
        else if (typeof dflt === 'boolean') value = dflt;
        else value = capable ? true : undefined; // toggle shown → defaults on
        return typeof value === 'boolean' ? { ...out, enable_thinking: value } : out;
    }

    /**
     * The reasoning levels a model offers (#23): per-model `reasoning_efforts`,
     * then the global one, as a list of strings such as
     * `["none", "low", "medium", "high"]`. Empty when the model takes no level,
     * as for NRP's vLLM models, which have only on/off (`reasoning_toggle`).
     * The model service sets it in each model's settings (glen#542).
     */
    reasoningLevels(modelConfig = this.getModelConfig()) {
        const v = ('reasoning_efforts' in (modelConfig ?? {}))
            ? modelConfig.reasoning_efforts
            : this.config?.reasoning_efforts;
        return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
    }

    /**
     * The reasoning level to send as `reasoning_effort`, or undefined to send
     * none (#23). The user's pick from the model's levels wins, then the
     * per-model `reasoning_effort`, then the global one. open-llm-proxy
     * forwards it unchanged (open-llm-proxy#205); the model server decides
     * what it accepts, so it is set only for models that take one.
     */
    reasoningEffort(modelConfig = this.getModelConfig()) {
        const levels = this.reasoningLevels(modelConfig);
        if (this.reasoningEffortOverride && levels.includes(this.reasoningEffortOverride)) {
            return this.reasoningEffortOverride;
        }
        const v = ('reasoning_effort' in (modelConfig ?? {}))
            ? modelConfig.reasoning_effort
            : this.config?.reasoning_effort;
        return typeof v === 'string' && v ? v : undefined;
    }

    /**
     * Whether to attach Anthropic-style `cache_control` breakpoints to the
     * outgoing prompt for this model (#273). Off by default — resolved per-model
     * first, then global (mirrors `_samplingParams`/`_thinkingParams`).
     *
     * This is a **Claude-specific** lever and should be enabled per-model on
     * Anthropic-routed entries only. Two reasons it's opt-in, not fleet-wide:
     *   1. Anthropic caching is opt-in — you get *nothing* without cache_control,
     *      so this is the only way Claude turns benefit. Open backends (NRP vLLM,
     *      some OpenRouter providers) already do automatic prefix caching for
     *      free, so the breakpoints buy them nothing.
     *   2. Enabling it reshapes the system message from a plain string into the
     *      content-parts array form (below) so the breakpoint has a block to ride
     *      on. That reshape — not the ignored `cache_control` key — is the only
     *      cross-backend compatibility surface; keeping it per-model avoids
     *      changing payload shape for models that gain nothing.
     * The open-llm-proxy forwards the `messages` array verbatim, so a
     * message-embedded breakpoint reaches the provider (unlike top-level cache
     * params, which the proxy drops). See #273.
     */
    _promptCacheEnabled(modelConfig) {
        const v = ('prompt_cache' in (modelConfig ?? {}))
            ? modelConfig.prompt_cache
            : this.config?.prompt_cache;
        return v === true;
    }

    /**
     * Return a copy of `messages` with a `cache_control` breakpoint on the
     * system prompt when prompt caching is enabled for this model, else the
     * array unchanged (byte-identical to today — the default path).
     *
     * The breakpoint goes on the system message because it carries the big,
     * every-call-identical prefix (base prompt + injected dataset catalog,
     * ~34k tokens per #294). On the Anthropic side the render order is
     * tools → system → messages, so a breakpoint on the last system block
     * caches the tool definitions too. Only string-content system messages are
     * reshaped; anything already in content-parts form is passed through.
     */
    _applyPromptCache(messages, modelConfig) {
        if (!this._promptCacheEnabled(modelConfig)) return messages;
        return messages.map(m =>
            m.role === 'system' && typeof m.content === 'string'
                ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
                : m
        );
    }

    /**
     * Resolve the per-attempt LLM timeout in milliseconds. Mirrors
     * `_samplingParams` resolution: per-model `llm_timeout_seconds` wins, then
     * global config, then a built-in default.
     *
     * Default is 600s to match the upstream llm-proxy's own timeout — a
     * shorter client cutoff (the old 300s) aborts responses the proxy would
     * still deliver, which made slow-decode models (e.g. glm-5.2, or anything
     * on the gb10) unusable. Slow reasoning models legitimately spend minutes
     * decoding; the client must not be the premature limiter. Raise per-model
     * (or globally) when the whole chain is configured to run longer.
     */
    _llmTimeoutMs(modelConfig) {
        const s = ('llm_timeout_seconds' in (modelConfig ?? {}))
            ? modelConfig.llm_timeout_seconds
            : this.config?.llm_timeout_seconds;
        return Number.isFinite(s) && s > 0 ? s * 1000 : 600000;
    }

    /**
     * Whether the endpoint is a trusted proxy host that should receive the
     * `X-Client` attribution header (#254). Gated because the harness runs in the
     * browser: a custom request header extends the CORS preflight, and a
     * bring-your-own endpoint whose `Access-Control-Allow-Headers` doesn't list
     * `X-Client` would have the browser block *every* request to it. Our proxy
     * allowlists it (and only our logs use it), so send it only there.
     *
     * Default allowlist is `nrp-nautilus.io` (our infra — the same origin the
     * proxy's own CORS regex trusts); override per deployment with
     * `client_header_hosts` (array of host suffixes).
     */
    _isTrustedProxyHost(endpoint) {
        let host;
        try { host = new URL(endpoint).hostname; } catch { return false; }
        const suffixes = this.config?.client_header_hosts ?? ['nrp-nautilus.io'];
        return suffixes.some(s => host === s || host.endsWith('.' + s));
    }

    /**
     * The `X-Client` header for log attribution, or `{}` when the endpoint isn't
     * a trusted proxy host (spread into the fetch headers). See #254.
     */
    _clientHeaders(endpoint) {
        return this._isTrustedProxyHost(endpoint)
            ? { 'X-Client': this.clientName }
            : {};
    }

    /**
     * Call the LLM API, retrying transient errors (gateway 5xx, network
     * blips, client-side timeout).
     *
     * Every retry gets the full `llm_timeout_seconds` budget. A slow thinking
     * model cannot answer a long-context request in a short window, so a
     * tight retry turned one 502 into a lost task (#437). A client timeout is
     * retried once. A 5xx or network error is retried up to
     * `retryDelaysMs.length` times, after waiting each delay in turn, so a
     * short gateway outage clears before the next attempt. A dead endpoint
     * still fails, only later. Stop ends a wait at once.
     */
    async callLLM(endpoint, modelConfig, messages, tools) {
        const payload = {
            model: this.selectedModel,
            messages: this._applyPromptCache(messages, modelConfig),
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : 'none',
            user: this.sessionId,
            ...this._samplingParams(modelConfig),
            ...this._thinkingParams(modelConfig),
        };

        const timeoutMs = this._llmTimeoutMs(modelConfig);
        for (let retries = 0; ; retries++) {
            // Log each request's start and end, so a stalled or repeated
            // request shows up in the console with its timing (glen-harness#24).
            const t0 = Date.now();
            const label = `${payload.model}, ${messages.length} messages${retries ? `, retry ${retries}` : ''}`;
            console.info(`[Agent] LLM request → ${label}`);
            try {
                const message = await this._attemptLLMCall(endpoint, modelConfig, payload, timeoutMs);
                console.info(`[Agent] LLM response ← ${Date.now() - t0} ms (${label})`);
                return message;
            } catch (error) {
                console.warn(`[Agent] LLM request failed after ${Date.now() - t0} ms (${label}): `
                    + `${error.timedOut ? 'timed out' : error.status ? `HTTP ${error.status}` : error.name || 'error'}`);
                if (!this._isTransientLLMError(error)) throw error;
                if (this.abortController?.signal.aborted) throw error; // user-Stop, don't retry
                const delays = Array.isArray(this.retryDelaysMs) ? this.retryDelaysMs : [];
                const allowed = error.timedOut ? 1 : delays.length;
                if (retries >= allowed) throw error;

                const waitMs = error.timedOut ? 0 : Math.max(0, delays[retries] || 0);
                console.warn(`[Agent] Transient LLM error, retry ${retries + 1} of ${allowed}`
                    + `${waitMs ? ` in ${Math.round(waitMs / 1000)}s` : ''}:`, error.message);
                this.onRetry?.(error, { attempt: retries + 1, of: allowed, waitMs });
                await this._waitBeforeRetry(waitMs);
            }
        }
    }

    /**
     * Wait before an LLM retry. Resolves early with an AbortError when the
     * user presses Stop, so a wait never holds up a stopped turn.
     */
    _waitBeforeRetry(ms) {
        if (!ms) return Promise.resolve();
        const signal = this.abortController?.signal;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    /**
     * Single attempt of the LLM fetch. Uses a per-attempt internal AbortController
     * so the timeout doesn't disturb the turn-level abortController (which the
     * outer loop's withAbort race depends on). User-pressed Stop is forwarded
     * from this.abortController to the internal controller.
     */
    async _attemptLLMCall(endpoint, modelConfig, payload, timeoutMs) {
        const internal = new AbortController();
        let timedOut = false;

        const userSignal = this.abortController?.signal;
        const forwardAbort = () => internal.abort();
        if (userSignal) {
            if (userSignal.aborted) internal.abort();
            else userSignal.addEventListener('abort', forwardAbort, { once: true });
        }

        const timeout = setTimeout(() => {
            timedOut = true;
            internal.abort();
        }, timeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // No header without a key, so basic-auth deployments keep working (glen#420).
                    ...(modelConfig.api_key ? { 'Authorization': `Bearer ${modelConfig.api_key}` } : {}),
                    ...this._clientHeaders(endpoint),
                },
                body: JSON.stringify(payload),
                signal: internal.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                const err = new Error(`LLM API error (${response.status}): ${errorText.substring(0, 200)}`);
                err.status = response.status;
                throw err;
            }

            const data = await response.json();
            const choice = data.choices[0];
            const message = choice.message;
            if (message && typeof message === 'object') {
                RESPONSE_END.set(message, {
                    finishReason: choice.finish_reason ?? null,
                    nativeFinishReason: choice.native_finish_reason ?? null,
                    completionTokens: data.usage?.completion_tokens ?? null,
                });
            }
            return message;
        } catch (error) {
            if (error.name === 'AbortError') {
                if (timedOut) {
                    const err = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
                    err.timedOut = true;
                    throw err;
                }
                throw error; // user-pressed Stop — let AbortError propagate
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            userSignal?.removeEventListener('abort', forwardAbort);
        }
    }

    /**
     * Classify an LLM error as transient (worth retrying) or permanent.
     * Retry on: client timeout, network errors, HTTP 5xx.
     * Skip on: user-pressed Stop (real AbortError), HTTP 4xx, anything else.
     */
    _isTransientLLMError(error) {
        if (error.name === 'AbortError') return false;
        if (error.timedOut) return true;
        if (error.name === 'TypeError') return true;
        if (typeof error.status === 'number' && error.status >= 500 && error.status < 600) return true;
        return false;
    }

    /**
     * Extract reasoning from a model message (mutates: strips reasoning_content
     * and inline <think> blocks so they don't get re-sent on the next turn).
     * Returns the combined reasoning text, or null if none was present.
     *
     * Handles two shapes:
     *   1. `reasoning_content` field (vLLM/qwen3/DeepSeek thinking-mode template)
     *   2. Inline <think>...</think> blocks in `content` (qwen3 default, others)
     */
    extractReasoning(message) {
        const parts = [];

        if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
            parts.push(message.reasoning_content.trim());
        }
        delete message.reasoning_content;

        if (typeof message.content === 'string' && message.content.includes('<think>')) {
            const pattern = /<think>([\s\S]*?)<\/think>/gi;
            let m;
            while ((m = pattern.exec(message.content)) !== null) {
                const text = m[1].trim();
                if (text) parts.push(text);
            }
            message.content = message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        }

        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    /**
     * Parse embedded tool calls from message content (#288, #295).
     *
     * Upstream hosts that stop emitting structured `tool_calls` fall back to a
     * grab-bag of content dialects — we must be tolerant of all of them or the
     * raw call leaks to the user as the final answer. Handled here:
     *   - Wrappers: <tool_call>… (GLM-style) *and* <tool_code>… (Gemini-style),
     *     with a missing / mismatched closing tag (#288, failure mode 1).
     *   - Bare, unwrapped JSON tool-call objects, singly or concatenated (#295).
     *   - Body shapes: flat {"name","arguments"} *and* nested OpenAI
     *     {"type":"function","function":{"name","arguments"}} (#295).
     *   - `parameters` as an alias for `arguments` (#295).
     */
    parseEmbeddedToolCalls(content) {
        if (!content) return [];
        const calls = [];

        // Wrapped calls: capture from a <tool_call>/<tool_code> open tag up to the
        // *first* of a closing tag (</… — including a mismatched </parameter>), a new
        // wrapper, or EOF, instead of requiring an exact close with no interior '<'.
        // The lookahead leaves the terminator unconsumed; each match still consumes
        // the literal open tag, so lastIndex always advances.
        const pattern = /<tool_c(?:all|ode)>\s*([\s\S]*?)\s*(?=<\/|<tool_c(?:all|ode)>|$)/gi;
        let match;
        let sawWrapper = false;
        while ((match = pattern.exec(content)) !== null) {
            sawWrapper = true;
            const inner = match[1].trim();
            if (inner) this._pushEmbeddedCall(inner, calls);
        }

        // Bare (unwrapped) tool-call JSON — only when no wrapper was seen, to avoid
        // double-extracting and to keep the scan off ordinary prose. `_normalizeCall`
        // is signature-gated, so a final answer that merely contains JSON (e.g. a
        // style blob) is not misread as a call.
        if (!sawWrapper) {
            for (const { value } of this._scanJSONObjects(content)) {
                const call = this._normalizeCall(value);
                if (call) calls.push(call);
            }
        }

        return calls;
    }

    /**
     * Remove recovered tool-call text from content before it is shown to the user
     * (#295). Strips both wrappers (closed, or unclosed to EOF), then excises any
     * bare tool-call JSON objects the parser would have recognized. Spans are
     * removed back-to-front so earlier indices stay valid.
     */
    stripEmbeddedCalls(content) {
        if (!content) return content;
        let out = content
            .replace(/<tool_c(?:all|ode)>[\s\S]*?<\/tool_c(?:all|ode)>/gi, '')
            .replace(/<tool_c(?:all|ode)>[\s\S]*$/gi, '');
        const spans = this._scanJSONObjects(out).filter(o => this._normalizeCall(o.value));
        for (let i = spans.length - 1; i >= 0; i--) {
            out = out.slice(0, spans[i].start) + out.slice(spans[i].end + 1);
        }
        return out.trim();
    }

    /**
     * Extract one or more calls from a single wrapper's inner blob (#295). Tries
     * JSON objects first (one or several concatenated), then the non-JSON shapes.
     */
    _pushEmbeddedCall(inner, calls) {
        // JSON object(s): flat or nested, lenient (a trailing extra brace still parses).
        let found = false;
        for (const { value } of this._scanJSONObjects(inner)) {
            const call = this._normalizeCall(value);
            if (call) { calls.push(call); found = true; }
        }
        if (found) return;

        // Function-call shape: tool_name({"arg": "val"})
        const funcMatch = inner.match(/^(\w+)\s*\(([\s\S]+)\)$/);
        if (funcMatch) {
            const args = this.parseLenientJSON(funcMatch[2]);
            if (args !== undefined) { calls.push({ name: funcMatch[1], args }); return; }
        }

        // Hermes/pythonic `<function=NAME>…` dialect (#295), incl. the corrupted
        // `<function=query", "arguments": {…}` form observed live on qwen/nimbus —
        // the sole failure mode still leaking under the #288 net. Take the name
        // from the tag, then the first JSON object after it as args, unwrapping a
        // lone {"arguments"|"parameters": {…}} envelope.
        const fnTag = inner.match(/<function=(\w+)/);
        if (fnTag) {
            const rest = inner.slice(fnTag.index + fnTag[0].length);
            const objs = this._scanJSONObjects(rest);
            let args = objs.length ? objs[0].value : {};
            if (args && typeof args === 'object' && !Array.isArray(args)) {
                const keys = Object.keys(args);
                if (keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'parameters')
                    && args[keys[0]] && typeof args[keys[0]] === 'object') {
                    args = args[keys[0]];
                }
            } else {
                args = {};
            }
            calls.push({ name: fnTag[1], args });
            return;
        }

        // Lone quoted name against a known tool: {"list_datasets"}
        const bareName = inner.match(/^\{\s*"(\w+)"\s*\}$/);
        if (bareName && this.toolRegistry.has(bareName[1])) {
            calls.push({ name: bareName[1], args: {} });
            return;
        }

        // Simple name
        if (/^\w+$/.test(inner) && this.toolRegistry.has(inner)) {
            calls.push({ name: inner, args: {} });
        }
    }

    /**
     * Normalize a parsed JSON value into {name, args} if it is a tool call, else
     * null (#295). Accepts both the flat shape and the nested OpenAI
     * {"type":"function","function":{…}} shape, and `parameters` as an alias for
     * `arguments`. Signature-gated for the bare-JSON path: a flat object with no
     * args key and an unregistered name is rejected so stray JSON in a final answer
     * is not swallowed as a call.
     */
    _normalizeCall(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const nested = parsed.type === 'function'
            && parsed.function && typeof parsed.function === 'object';
        const fn = nested ? parsed.function : parsed;
        const name = fn.name;
        if (typeof name !== 'string' || !name) return null;
        const hasArgsKey = ('arguments' in fn) || ('parameters' in fn);
        if (!nested && !hasArgsKey && !this.toolRegistry.has(name)) return null;
        let args = fn.arguments ?? fn.parameters ?? {};
        if (typeof args === 'string') args = this.parseLenientJSON(args) ?? {};
        if (!args || typeof args !== 'object') args = {};
        return { name, args };
    }

    /**
     * Parse a JSON value leniently (#288, failure mode 2/3). Tries a strict parse
     * first; on failure, falls back to a raw_decode-style scan that returns the
     * first complete, balanced JSON object/array and ignores any trailing junk —
     * recovering the common `{"k": "v"}}` extra-brace case. Returns the parsed
     * value, or `undefined` if nothing valid could be extracted.
     */
    parseLenientJSON(str) {
        if (typeof str !== 'string') return undefined;
        const s = str.trim();
        if (!s) return undefined;
        try {
            return JSON.parse(s);
        } catch { /* fall through to raw_decode */ }
        return this._decodeFirstJSON(s);
    }

    /**
     * raw_decode helper: scan from the first '{' or '[' and return the first
     * balanced, valid JSON value, respecting strings and escapes. Trailing text
     * after the balanced value is ignored. Returns `undefined` on no match.
     */
    _decodeFirstJSON(s) {
        const start = s.search(/[{[]/);
        if (start === -1) return undefined;
        const end = this._matchBalanced(s, start);
        if (end === -1) return undefined;
        try {
            return JSON.parse(s.slice(start, end + 1));
        } catch {
            return undefined;
        }
    }

    /**
     * Index of the closer that balances the opening bracket at `start`, or -1 if
     * none. Respects strings and escapes so a bracket inside a string literal is
     * not mistaken for structure. Shared by _decodeFirstJSON and _scanJSONObjects.
     */
    _matchBalanced(s, start) {
        const open = s[start];
        const close = open === '{' ? '}' : open === '[' ? ']' : null;
        if (!close) return -1;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === open) depth++;
            else if (c === close && --depth === 0) return i;
        }
        return -1;
    }

    /**
     * Scan a string for all top-level balanced JSON objects/arrays and return the
     * valid ones as {value, start, end} (end inclusive). Handles several calls
     * concatenated in one blob (#295) and, because it carries positions, lets the
     * display stripper excise recovered bare calls. Invalid/unbalanced regions and
     * non-JSON prose between objects are skipped.
     */
    _scanJSONObjects(s) {
        const results = [];
        if (typeof s !== 'string') return results;
        let i = 0;
        while (i < s.length) {
            const rel = s.slice(i).search(/[{[]/);
            if (rel === -1) break;
            const start = i + rel;
            const end = this._matchBalanced(s, start);
            if (end === -1) { i = start + 1; continue; }
            try {
                results.push({ value: JSON.parse(s.slice(start, end + 1)), start, end });
            } catch { /* skip this region */ }
            i = end + 1;
        }
        return results;
    }

    /**
     * Canonicalize a message's native tool-call `arguments` to valid JSON strings
     * (#288, failure mode 2). A malformed `arguments` string left verbatim in the
     * assistant message poisons the next upstream request. We parse leniently and
     * re-serialize; anything unrecoverable becomes `{}` so history stays valid.
     * Also recovers per-argument dialect leaks (#313, see scrubArgDialectLeaks).
     * Mutates the message in place.
     */
    normalizeToolCallArguments(message) {
        if (!Array.isArray(message?.tool_calls)) return;
        for (const tc of message.tool_calls) {
            if (!tc.function) continue;
            const raw = tc.function.arguments;
            // A string is parsed leniently (recovers the #288 extra-brace case);
            // some backends hand back an object directly. Anything unrecoverable
            // becomes {}. Scrub arg-dialect leaks out of the parsed object before
            // re-serializing, so both history and execution see the real values.
            const parsed = typeof raw === 'string'
                ? (this.parseLenientJSON(raw) ?? {})
                : (raw ?? {});
            tc.function.arguments = JSON.stringify(this.scrubArgDialectLeaks(parsed));
        }
    }

    /**
     * Recover a per-argument tool-call dialect leak (#313). Some backends
     * (observed live on `z-ai/glm-5.2`) serialize a structured argument's *value*
     * in an XML arg dialect — `<arg_key>NAME</arg_key> <arg_value>{…}</arg_value>`
     * (or `<parameter=NAME>…</parameter>`) — which arrives as a JSON *string*
     * rather than the parsed object. The outer `arguments` blob is otherwise valid
     * JSON, so the parse in normalizeToolCallArguments succeeds and the leak reaches
     * the tool as a string that fails its schema (e.g. add_hex_tile_layer rejecting
     * a `value_stats` string). The real payload is intact inside the wrapper — this
     * unwraps it. Defense-in-depth: the durable fix normalizes the dialect at the
     * server/proxy (see docs/design/tool-call-parsing.md and open-llm-proxy#85).
     *
     * Only string values carrying an `<arg_value>` / `<parameter …>` marker are
     * touched: the payload after the marker is parsed as JSON when it's an
     * object/array, else taken as a plain scalar (trailing close tag stripped).
     * A missing/mismatched close tag is tolerated, matching parseEmbeddedToolCalls.
     * Values with no marker are left byte-for-byte unchanged. Mutates and returns.
     */
    scrubArgDialectLeaks(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
        for (const key of Object.keys(args)) {
            const v = args[key];
            if (typeof v !== 'string') continue;
            const marker = v.match(/<(?:arg_value|parameter\b[^>]*)>/i);
            if (!marker) continue;
            const after = v.slice(marker.index + marker[0].length);
            const parsed = this.parseLenientJSON(after);
            if (parsed && typeof parsed === 'object') {
                args[key] = parsed;
                continue;
            }
            const scalar = after.replace(/<\/(?:arg_value|parameter)>\s*$/i, '').trim();
            if (scalar) args[key] = scalar;
        }
        return args;
    }

    /**
     * Whether a tool-execution result represents a failure (#313), by the
     * registry's one rule ({@link isFailedToolResult}): a registry error or
     * unknown tool, the invalid-JSON sentinel, an `Error…` or MCP `SQL Error…`
     * string (#395), or a `{"success": false}` envelope. Drives the
     * repeated-failure short-circuit.
     */
    _isFailedResult(r) {
        return isFailedToolResult(r);
    }

    /**
     * Heuristic (#288): does this content look like an *attempted* tool call that
     * we failed to parse? Kept tight to avoid re-prompting genuine final answers.
     */
    looksLikeAttemptedToolCall(content) {
        if (!content) return false;
        if (/<tool_c(?:all|ode)/i.test(content)) return true;
        if (/"(?:name|function|parameters|arguments)"\s*:/.test(content)) return true;
        // Non-JSON XML-ish tool-call markers no genuine prose emits (#297): the
        // corrupted `<function=NAME>` tag, mangled `<parameter=…>` / `<parameter …>`,
        // and Claude's `<invoke …>` / `<model_calls>` fn-call XML.
        if (/<function=|<parameter[=\s]|<invoke\b|<model_calls>/i.test(content)) return true;
        // Bare call or tool-name-as-tag against a *known* tool — gated on the
        // registry so prose that merely names a tool doesn't trip a re-prompt (#297).
        // Covers the whole leaking tail so the #288 recovery at least fires:
        //   show_layer(layer_id="…")   and   <show_layer>{…}</show_layer>
        // Scan *all* matches, not just the first — the real tool tag is often
        // preceded by hallucinated reasoning tags (<antThinking>, </think>, …).
        // The `(` must be followed by something call-shaped — a quote, `{`/`[`, or
        // a `kwarg=` — so a common tool word in prose ("the query (SQL) returned …",
        // "set_filter (applied earlier)") is not misread as an attempted call.
        for (const m of content.matchAll(/\b(\w+)\s*\(\s*(?:["'{[]|[\w-]+\s*=)/g)) {
            if (this.toolRegistry.has(m[1])) return true;
        }
        for (const m of content.matchAll(/<(\w+)[\s>]/g)) {
            if (this.toolRegistry.has(m[1])) return true;
        }
        return false;
    }

    /**
     * The sentence in a final answer that announces a check or computation
     * the model is about to do, such as "Let me also verify …" or "I'll run a
     * query for …", or null (glen-harness#26). A reply with no tool call
     * cannot do what such a sentence says.
     *
     * Offers to the user ("Want me to check…?", "I can verify…", "If you'd
     * like, I'll run…") and questions are not announcements, and neither is
     * anything in a code block or a quote.
     */
    announcedCheck(content) {
        if (!content) return null;
        const text = content
            .replace(/```[\s\S]*?```/g, ' ')
            .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
        for (const raw of text.split(/(?<=[.!?:])\s+|\n+/)) {
            const sentence = raw.trim();
            if (!sentence || sentence.endsWith('?')) continue;
            if (OFFER.test(sentence)) continue;
            if (ANNOUNCE.test(sentence)) return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
        }
        return null;
    }

    /**
     * Convert parsed embedded calls to synthetic tool_calls format.
     */
    syntheticToolCalls(calls) {
        return calls.map(tc => ({
            id: `emb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args),
            }
        }));
    }

    /**
     * Put a finished turn into history, in its shorter form, in place of the
     * entries the turn added while it ran: its opening message, and for a
     * resumed turn the checkpoint summary and the message that resumed it.
     * Keeping the tool calls lets a follow-up see which numbers were computed
     * and how (glen-harness#21). Messages a host added during the turn stay,
     * after it.
     *
     * The turn is shortened once, here, and never changed again, so every
     * later request starts with the same bytes and the provider's prompt
     * cache keeps covering it.
     */
    _keepTurn({ turnMessages, turnStart, ownEntries }) {
        const at = this.messages.indexOf(ownEntries[0]);
        if (at === -1 || !Number.isInteger(turnStart)) {
            // History was cleared while the turn ran; nothing to put back.
            return;
        }
        const own = new Set(ownEntries);
        const kept = this._historyTurn(turnMessages.slice(turnStart));
        const later = this.messages.slice(at).filter(m => !own.has(m));
        this.messages.splice(at, this.messages.length - at, ...kept, ...later);
    }

    /**
     * A finished turn's messages as history keeps them. The harness's own
     * prompts are left out, with the unparseable reply a re-prompt answered,
     * so two assistant messages never end up side by side.
     */
    _historyTurn(msgs) {
        const out = [];
        msgs.forEach((m, i) => {
            if (HARNESS_PROMPTS.has(m)) {
                const prev = out.at(-1);
                if (prev?.role === 'assistant' && !prev.tool_calls && msgs[i + 1]?.role === 'assistant') out.pop();
                return;
            }
            out.push(this._historyMessage(m));
        });
        return out;
    }

    /**
     * One message as history keeps it. A tool result is cut to
     * HISTORY_RESULT_CHARS. A reply keeps its text and tool calls and loses
     * everything else the provider sent with it, such as reasoning. A reply
     * whose calls were recovered from its text is given them as `tool_calls`,
     * with the call text stripped, so the results after it are not orphaned.
     */
    _historyMessage(m) {
        if (m.role === 'tool') {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const len = content.length;
            return {
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: len <= HISTORY_RESULT_CHARS ? content
                    : `${content.slice(0, HISTORY_RESULT_CHARS)}\n... (first ${HISTORY_RESULT_CHARS} of ${len} `
                        + 'characters; run the tool again if you need the rest)',
            };
        }
        if (m.role !== 'assistant') return m;

        const recovered = RECOVERED_CALLS.get(m);
        const calls = m.tool_calls?.length ? m.tool_calls : recovered;
        const content = (recovered ? this.stripEmbeddedCalls(m.content || '').trim() : m.content) || null;
        if (!calls) return { role: 'assistant', content: content ?? '' };
        return {
            role: 'assistant',
            content,
            tool_calls: calls.map(tc => {
                const args = typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments ?? {});
                return {
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.function?.name,
                        arguments: args.length <= HISTORY_ARGS_CHARS ? args
                            : JSON.stringify({ omitted: `${args.length} characters of arguments left out of history` }),
                    },
                };
            }),
        };
    }

    /**
     * The history budget in characters: per-model `history_budget_chars`,
     * then the global setting, then HISTORY_BUDGET_CHARS.
     */
    _historyBudget(modelConfig) {
        const n = ('history_budget_chars' in (modelConfig ?? {}))
            ? modelConfig.history_budget_chars
            : this.config?.history_budget_chars;
        return Number.isFinite(n) && n > 0 ? n : HISTORY_BUDGET_CHARS;
    }

    /**
     * Where each turn starts in this.messages, in order. A turn starts at its
     * opening message, or at the host notes just before it. Anything before
     * the first turn counts as a turn of its own. Every start is a user
     * message or index 0, so cutting there never separates a tool call from
     * its result.
     */
    _turnStarts() {
        const msgs = this.messages;
        let isStart = (m) => TURN_OPENERS.has(m);
        // History built by a host rather than by processMessage: any user
        // message after a non-user one starts a turn.
        if (!msgs.some(isStart)) {
            isStart = (m, i) => m.role === 'user' && (i === 0 || msgs[i - 1].role !== 'user');
        }
        const starts = [];
        msgs.forEach((m, i) => {
            if (!isStart(m, i)) return;
            let s = i;
            while (s > 0 && msgs[s - 1].role === 'user' && !TURN_OPENERS.has(msgs[s - 1])) s--;
            if (starts.at(-1) !== s) starts.push(s);
        });
        if (starts[0] !== 0) starts.unshift(0);
        return starts;
    }

    /**
     * Keep history within the budget before a new turn is sent. When it is
     * over, drop the oldest turns until it is under HISTORY_TARGET_SHARE of
     * the budget. The current turn and the one before it are never dropped.
     */
    _fitHistory(modelConfig) {
        const budget = this._historyBudget(modelConfig);
        const size = (m) => JSON.stringify(m).length;
        let total = this.messages.reduce((n, m) => n + size(m), 0);
        if (total <= budget) return;
        const target = budget * HISTORY_TARGET_SHARE;
        const starts = this._turnStarts();
        let cut = 0;
        for (let t = 0; t < starts.length - 2 && total > target; t++) {
            for (let i = starts[t]; i < starts[t + 1]; i++) total -= size(this.messages[i]);
            cut = starts[t + 1];
        }
        if (cut > 0) this.messages.splice(0, cut);
    }

    /**
     * Clear conversation history. Also drops the registry's idempotent-read
     * memo cache (#281) so a fresh conversation re-fetches metadata rather than
     * serving results cached during the previous one.
     */
    clearHistory() {
        this.messages = [];
        this.toolRegistry?.clearMemo?.();
    }
}
