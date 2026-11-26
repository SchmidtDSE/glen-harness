import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';

// Cross-turn history keeps each turn's tool calls and results
// (glen-harness#21), so a follow-up can see which numbers were computed.

const registry = (overrides = {}) => ({
    getToolsForLLM: () => [],
    isLocal: () => false,
    has: () => true,
    execute: async (name, args) => ({ result: `rows for ${JSON.stringify(args)}` }),
    ...overrides,
});

const makeAgent = (config = {}, reg = registry()) => {
    const agent = new Agent(
        { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }], ...config },
        reg,
    );
    agent.setSystemPrompt('system');
    return agent;
};

const reply = (message, finish_reason = 'stop') => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] }),
});
const text = (content) => reply({ content });
const call = (id, sql) => reply({
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'query', arguments: JSON.stringify({ sql }) } }],
});

// Queue replies and record each request body.
function mockLLM(...replies) {
    const sent = [];
    global.fetch = vi.fn(async (_url, opts) => {
        sent.push(JSON.parse(opts.body));
        const next = replies.shift();
        if (!next) throw new Error('no reply queued');
        return next;
    });
    return sent;
}

// Every tool message must answer a call in the assistant message before it,
// with only other tool messages in between, or a provider rejects the request.
function expectPairedToolMessages(messages) {
    messages.forEach((m, i) => {
        if (m.role !== 'tool') return;
        let j = i - 1;
        while (j >= 0 && messages[j].role === 'tool') j--;
        const owner = messages[j];
        expect(owner?.role, `tool message ${i} has no assistant call before it`).toBe('assistant');
        expect(owner.tool_calls?.map(c => c.id)).toContain(m.tool_call_id);
    });
}

describe('cross-turn history (glen-harness#21)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('sends the earlier turn\'s tool calls and results with a follow-up', async () => {
        const sent = mockLLM(
            call('c1', 'SELECT count(*) FROM t'),
            text('There are 42 rows.'),
            text('I counted them with SELECT count(*) FROM t.'),
        );
        const agent = makeAgent();

        await agent.processMessage('How many rows?');
        await agent.processMessage('What data did you use?');

        const followUp = sent[2].messages;
        expect(followUp.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
        expect(followUp[2].tool_calls[0].function.arguments).toContain('SELECT count(*) FROM t');
        expect(followUp[3].content).toContain('rows for');
        expect(followUp[4].content).toBe('There are 42 rows.');
        expectPairedToolMessages(followUp);
    });

    it('never changes a kept turn, so each request starts with the one before it and the cache applies', async () => {
        const sent = mockLLM(
            call('c1', 'SELECT 1'), text('one'),
            call('c2', 'SELECT 2'), text('two'),
            text('three'),
        );
        const agent = makeAgent({}, registry({ execute: async () => ({ result: 'x'.repeat(5000) }) }));

        await agent.processMessage('q1');
        await agent.processMessage('q2');
        await agent.processMessage('q3');

        const second = sent[2].messages; // first request of turn 2
        const third = sent[4].messages; // first request of turn 3
        expect(third.slice(0, second.length)).toEqual(second);
    });

    it('cuts each tool result to 1,000 characters when the turn ends', async () => {
        const big = 'x'.repeat(5000);
        const sent = mockLLM(call('c1', 'SELECT 1'), text('one'), text('ok'));
        const agent = makeAgent({}, registry({ execute: async () => ({ result: big }) }));

        await agent.processMessage('q1');
        // Within the turn the model saw the whole result.
        expect(sent[1].messages.find(m => m.role === 'tool').content).toBe(big);

        await agent.processMessage('q2');
        const kept = sent[2].messages.find(m => m.role === 'tool').content;
        expect(kept.startsWith('x'.repeat(1000))).toBe(true);
        expect(kept).toContain('first 1000 of 5000 characters');
        expect(kept.length).toBeLessThan(1100);
    });

    it('keeps replies to text and tool calls, leaving out reasoning and other provider fields', async () => {
        mockLLM(
            reply({ content: null, reasoning: 'long thoughts', reasoning_details: [{ text: 'x' }], refusal: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query', arguments: '{"sql":"SELECT 1"}' } }] }),
            reply({ content: 'one', reasoning: 'more thoughts' }),
        );
        const agent = makeAgent();

        await agent.processMessage('q1');

        expect(agent.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'query', arguments: '{"sql":"SELECT 1"}' } },
        ] });
        expect(agent.messages[3]).toEqual({ role: 'assistant', content: 'one' });
    });

    it('replaces very long arguments, such as a drawn polygon, with a note', async () => {
        const polygon = JSON.stringify({ geojson: 'y'.repeat(6000) });
        mockLLM(
            reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query', arguments: polygon } }] }),
            text('done'),
        );
        const agent = makeAgent();

        await agent.processMessage('q1');

        const args = agent.messages[1].tool_calls[0].function.arguments;
        expect(JSON.parse(args).omitted).toMatch(/characters of arguments left out/);
    });

    it('leaves out a re-prompt after an unparseable call, with the reply it answered', async () => {
        mockLLM(
            text('<tool_call>{"name": "query", "arguments": {"sql": </tool_call>'),
            call('c1', 'SELECT 1'),
            text('one'),
        );
        const agent = makeAgent();

        await agent.processMessage('q1');

        expect(agent.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(agent.messages.some(m => /could not be parsed/.test(m.content))).toBe(false);
    });

    it('keeps the final answer as the last history message', async () => {
        mockLLM(call('c1', 'SELECT 1'), text('one'));
        const agent = makeAgent();
        await agent.processMessage('q1');
        expect(agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'one' });
    });

    it('keeps a host note added during the turn, after the turn\'s trace', async () => {
        const agent = makeAgent({}, registry({
            execute: async () => {
                agent.messages.push({ role: 'user', content: '[The user has drawn a region]' });
                return { result: 'rows' };
            },
        }));
        mockLLM(call('c1', 'SELECT 1'), text('one'));

        await agent.processMessage('q1');

        expect(agent.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
        expect(agent.messages.at(-1).content).toContain('drawn a region');
    });

    it('replaces a checkpoint summary with the full trace once the resumed turn ends', async () => {
        mockLLM(
            call('c1', 'SELECT 1'),
            text('Summary so far.'),
            call('c2', 'SELECT 2'),
            text('Final answer.'),
        );
        const agent = makeAgent({ max_tool_calls: 1 });

        const first = await agent.processMessage('hard question');
        expect(first.checkpoint).toBe(true);
        expect(agent.messages.map(m => m.role)).toEqual(['user', 'assistant']);

        // Raise the cap so the resumed turn can finish.
        agent.maxToolCalls = 10;
        const second = await agent.processMessage('continue');
        expect(second.response).toBe('Final answer.');

        const roles = agent.messages.map(m => m.role);
        expect(roles).toEqual([
            'user', 'assistant', 'tool', // hard question, first call
            'assistant', // summary (the checkpoint request is left out)
            'user', 'assistant', 'tool', // continue, second call
            'assistant', // final answer
        ]);
        expect(agent.messages.filter(m => m.content === 'Summary so far.')).toHaveLength(1);
        expectPairedToolMessages(agent.messages);
    });

    it('gives a reply whose call was recovered from its text the call as tool_calls', async () => {
        mockLLM(
            text('Let me look. <tool_call>{"name": "query", "arguments": {"sql": "SELECT 1"}}</tool_call>'),
            text('one'),
        );
        const agent = makeAgent();

        await agent.processMessage('q1');

        const [, withCall, result] = agent.messages;
        expect(withCall.tool_calls[0].function.name).toBe('query');
        expect(withCall.content).toBe('Let me look.');
        expect(result.tool_call_id).toBe(withCall.tool_calls[0].id);
        expectPairedToolMessages(agent.messages);
    });

    it('keeps the trace of an answer cut off at the output limit', async () => {
        mockLLM(call('c1', 'SELECT 1'), reply({ content: 'Partial answer' }, 'length'));
        const agent = makeAgent();

        const { truncated } = await agent.processMessage('q1');

        expect(truncated).toBe(true);
        expect(agent.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(agent.messages.at(-1).content).toContain('Partial answer');
    });

    it('does not put a trace back when history was cleared during the turn', async () => {
        const agent = makeAgent({}, registry({
            execute: async () => { agent.clearHistory(); return { result: 'rows' }; },
        }));
        mockLLM(call('c1', 'SELECT 1'), text('one'));

        await agent.processMessage('q1');

        expect(agent.messages).toEqual([]);
    });
});

describe('history budget', () => {
    afterEach(() => vi.restoreAllMocks());

    const big = 'x'.repeat(5000);

    // One turn per question, each running one query that returns `big`.
    async function runTurns(agent, n) {
        const sent = [];
        for (let i = 0; i < n; i++) {
            const turn = mockLLM(call(`c${i}`, `SELECT ${i}`), text(`answer ${i}`));
            await agent.processMessage(`question ${i}`);
            sent.push(...turn);
        }
        return sent;
    }

    it('leaves history alone while it is under budget', async () => {
        const agent = makeAgent({}, registry({ execute: async () => ({ result: big }) }));
        await runTurns(agent, 3);
        expect(agent.messages.filter(m => m.role === 'user')).toHaveLength(3);
    });

    it('drops the oldest turns once over budget, never splitting a call from its result', async () => {
        const agent = makeAgent({ history_budget_chars: 3000 }, registry({ execute: async () => ({ result: big }) }));
        const sent = await runTurns(agent, 6);

        const last = sent.at(-1).messages;
        expect(last[0].role).toBe('system');
        expect(last[1].role).toBe('user');
        expect(last.some(m => m.content === 'question 0')).toBe(false);
        expect(last.some(m => m.content === 'answer 4')).toBe(true);
        expectPairedToolMessages(last);
        for (const body of sent) expectPairedToolMessages(body.messages);
    });

    it('reads the budget per model before the global setting', () => {
        const agent = makeAgent({ history_budget_chars: 1000 });
        expect(agent._historyBudget({ history_budget_chars: 50 })).toBe(50);
        expect(agent._historyBudget({})).toBe(1000);
        expect(makeAgent()._historyBudget({})).toBe(60000);
    });

    it('cuts at turn boundaries in history a host built itself', () => {
        const agent = makeAgent({ history_budget_chars: 100 });
        agent.messages.push(
            { role: 'user', content: 'old question' },
            { role: 'assistant', content: 'old answer '.repeat(20) },
            { role: 'user', content: 'recent question' },
            { role: 'assistant', content: 'recent answer' },
            { role: 'user', content: 'new question' },
        );
        agent._fitHistory({});
        expect(agent.messages.map(m => m.content)).toEqual(['recent question', 'recent answer', 'new question']);
    });
});
