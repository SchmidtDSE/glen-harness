import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';

const makeAgent = (execute) => {
    const agent = new Agent(
        { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }] },
        {
            getToolsForLLM: () => [],
            isLocal: () => false,
            has: () => true,
            execute: execute ?? (async () => ({ success: true, result: 'rows' })),
        },
    );
    agent.setSystemPrompt('system');
    return agent;
};

const reply = (message) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] }),
});
const text = (content) => reply({ content });
const call = (id, name = 'get_schema', args = { dataset_id: 'ca30x30' }) => reply({
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

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

describe('repeated successful call (glen-harness#19)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does not run an identical repeat, then checkpoints on the next one', async () => {
        const execute = vi.fn(async () => ({ success: true, result: 'columns: a, b' }));
        const sent = mockLLM(
            call('c1'), // runs
            call('c2'), // repeat: not run, model told to use the result
            call('c3'), // repeat again: checkpoint
            text('Summary: I kept asking for the schema.'),
        );
        const agent = makeAgent(execute);

        const result = await agent.processMessage('How many acres are conserved?');

        expect(execute).toHaveBeenCalledTimes(1);
        expect(result.checkpoint).toBe(true);
        expect(sent).toHaveLength(4);
        const skipped = sent[2].messages.at(-1);
        expect(skipped).toMatchObject({ role: 'tool', tool_call_id: 'c2' });
        expect(skipped.content).toContain('already called get_schema');
    });

    it('carries on normally when the model uses the earlier result after one repeat', async () => {
        const execute = vi.fn(async () => ({ success: true, result: 'columns: a, b' }));
        mockLLM(
            call('c1'),
            call('c2'), // repeat: not run
            call('c3', 'query', { sql_query: 'SELECT 1' }), // different call: runs
            text('26,471,459 acres.'),
        );
        const agent = makeAgent(execute);

        const result = await agent.processMessage('How many acres are conserved?');

        expect(execute).toHaveBeenCalledTimes(2);
        expect(result.response).toBe('26,471,459 acres.');
    });

    it('runs the same call again when another call came between', async () => {
        const execute = vi.fn(async () => ({ success: true, result: 'ok' }));
        mockLLM(
            call('c1'),
            call('c2', 'query', { sql_query: 'SELECT 1' }),
            call('c3'),
            text('done'),
        );
        const agent = makeAgent(execute);

        await agent.processMessage('q');

        expect(execute).toHaveBeenCalledTimes(3);
    });
});

describe('empty reply (glen-harness#25)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('asks once more after an empty reply, without sending the empty reply back', async () => {
        const sent = mockLLM(call('c1'), text(''), text('The answer is 42.'));
        const agent = makeAgent();

        const result = await agent.processMessage('q');

        expect(result.response).toBe('The answer is 42.');
        const retry = sent[2].messages;
        expect(retry.at(-1).role).toBe('user');
        expect(retry.at(-1).content).toContain('Your last reply was empty');
        expect(retry.some(m => m.role === 'assistant' && m.content === '')).toBe(false);
        // The retry prompt is not kept in history.
        expect(agent.messages.some(m => /last reply was empty/.test(m.content))).toBe(false);
        expect(agent.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('falls back after a second empty reply', async () => {
        mockLLM(text(''), text(''));
        const agent = makeAgent();

        const result = await agent.processMessage('q');

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result.response).toMatch(/trouble generating a response/);
    });
});
