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

describe('no model configured (glen#542)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('refuses with a clear error instead of sending a request to a made-up endpoint', async () => {
        global.fetch = vi.fn();
        const agent = new Agent({}, { getToolsForLLM: () => [] });
        expect(agent.getModelConfig()).toBeNull();
        await expect(agent.processMessage('q')).rejects.toThrow(/model service could not be reached/);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(agent.messages).toEqual([]);
    });
});

describe('final answer that announces a check it never ran (glen-harness#26)', () => {
    afterEach(() => vi.restoreAllMocks());
    const agent = () => makeAgent();

    it('finds announcements', () => {
        const a = agent();
        expect(a.announcedCheck('I have the answer. Let me also verify there\'s nothing closer in a neighboring h0 partition.'))
            .toBe('Let me also verify there\'s nothing closer in a neighboring h0 partition.');
        expect(a.announcedCheck('The total is 26.5M acres.\n\nI\'ll now run a query for the GAP 2 share.')).toMatch(/^I'll now run/);
        expect(a.announcedCheck('Next, I\'ll check the 2023 data.')).toBe('Next, I\'ll check the 2023 data.');
        expect(a.announcedCheck('Let me double-check the denominator.')).toBe('Let me double-check the denominator.');
    });

    it('leaves offers, questions, in-place arithmetic, past tense and code alone', () => {
        const a = agent();
        for (const text of [
            'Want me to check the neighboring partitions?',
            'Should I run the same query for 2023?',
            'If you\'d like, I\'ll run the same query for 2023.',
            'I can verify this against the GFW totals.',
            'Let me know if you want a breakdown by county.',
            'Say the word and I\'ll run that.',
            'Blue oak or coast live oak woodland — say which and I\'ll run it.',
            'If you meant the Namibian site instead, let me know and I\'ll re-frame.',
            'The map is running headless in this session, so I\'ll report the numbers directly.',
            'Let me calculate: 26.5 / 101.5 = 26.1%.',
            'Let me put the two figures together: 17.7M + 8.7M = 26.5M.',
            'I checked the schema and ran one query.',
            'The answer is 26.5 million acres.\n\n```sql\n-- let me check\nSELECT 1\n```',
            '> Let me verify this, the user wrote.',
            '',
        ]) expect(a.announcedCheck(text), text).toBeNull();
    });

    it('asks once, then runs the check the model announced', async () => {
        const execute = vi.fn(async () => ({ success: true, result: 'nearest: 156.3 km' }));
        const sent = mockLLM(
            call('c1', 'query', { sql_query: 'SELECT 1' }),
            text('I have the answer: 260 km. Let me also verify there is nothing closer in a neighboring partition.'),
            call('c2', 'query', { sql_query: 'SELECT 2' }),
            text('The nearest fishing was 156.3 km away.'),
        );
        const a = makeAgent(execute);

        const result = await a.processMessage('How close did fishing come to Jarvis Island?');

        expect(result.response).toBe('The nearest fishing was 156.3 km away.');
        expect(execute).toHaveBeenCalledTimes(2);
        const prompt = sent[2].messages.at(-1);
        expect(prompt.role).toBe('user');
        expect(prompt.content).toContain('Let me also verify there is nothing closer');
        // Neither the announcing reply nor the prompt stays in history.
        expect(a.messages.some(m => /260 km|called no tool/.test(m.content ?? ''))).toBe(false);
        expect(a.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    });

    it('accepts the second reply as final, even if it announces again', async () => {
        mockLLM(
            text('Let me verify that first.'),
            text('Let me verify that again.'),
        );
        const a = makeAgent();
        const result = await a.processMessage('q');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result.response).toBe('Let me verify that again.');
    });
});
