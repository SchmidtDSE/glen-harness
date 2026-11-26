import { describe, it, expect, vi } from 'vitest';
import {
    modelsUrl, fetchModelList, modelEndpoint, modelsFromTierList, ModelListError,
    applyProxyModelList, buildUserModels, loadUserSettings, fetchModelIds,
    STORAGE_KEY_API, STORAGE_KEY_ENDPOINT, STORAGE_KEY_MODEL,
} from '../src/llm-models.js';
import { Agent } from '../src/agent.js';

const tierList = (over = {}) => ({
    object: 'list', tier: 'public', default_model: 'deepseek-v4-flash',
    data: [
        { id: 'glm-5', provider: 'nrp' },
        { id: 'deepseek-v4-flash', provider: 'nrp', default: true },
        { id: 'kimi', provider: 'nrp' },
    ],
    ...over,
});

const okFetch = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));

describe('modelsUrl', () => {
    it('puts /models beside the endpoint', () => {
        expect(modelsUrl('/api/llm')).toBe('/api/llm/models');
        expect(modelsUrl('/api/llm/')).toBe('/api/llm/models');
        expect(modelsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/models');
        expect(modelsUrl('https://x.org/v1/chat/completions')).toBe('https://x.org/v1/models');
    });
});

describe('fetchModelList', () => {
    it('sends the key as a bearer header and returns the body', async () => {
        const f = okFetch(tierList());
        const list = await fetchModelList('/api/llm', { apiKey: 'k', fetchImpl: f });
        expect(list.tier).toBe('public');
        expect(f.mock.calls[0][0]).toBe('/api/llm/models');
        expect(f.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer k' });
    });

    it('sends no Authorization header without a key (basic-auth deployments, #420)', async () => {
        const f = okFetch(tierList());
        await fetchModelList('/api/llm', { fetchImpl: f });
        expect(f.mock.calls[0][1].headers).toEqual({});
    });

    it('returns null on HTTP errors, bad bodies and network failures', async () => {
        expect(await fetchModelList('/api/llm', { fetchImpl: async () => ({ ok: false }) })).toBeNull();
        expect(await fetchModelList('/api/llm', { fetchImpl: okFetch({ nope: 1 }) })).toBeNull();
        expect(await fetchModelList('/api/llm', { fetchImpl: async () => { throw new Error('x'); } })).toBeNull();
        expect(await fetchModelList('/api/llm', {
            fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }),
        })).toBeNull();
        expect(await fetchModelList('', { fetchImpl: okFetch(tierList()) })).toBeNull();
    });

    it('gives up after the timeout', async () => {
        const hang = (_url, { signal }) => new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))));
        expect(await fetchModelList('/api/llm', { fetchImpl: hang, timeoutMs: 5 })).toBeNull();
    });
});

describe('modelEndpoint (glen#542)', () => {
    it('reads llm_endpoint, and llm_api_key only when set', () => {
        expect(modelEndpoint({ llm_endpoint: '/api/llm' })).toEqual({ endpoint: '/api/llm', apiKey: undefined });
        expect(modelEndpoint({ llm_endpoint: '/api/llm', llm_api_key: 'k' })).toEqual({ endpoint: '/api/llm', apiKey: 'k' });
    });
    it('falls back to the first llm_models entry\'s endpoint and key, ignoring the other entries', () => {
        const config = { llm_models: [{ value: 'a', endpoint: '/a', api_key: 'app-token' }, { value: 'b', endpoint: '/b', api_key: 'x' }] };
        expect(modelEndpoint(config)).toEqual({ endpoint: '/a', apiKey: 'app-token' });
        expect(modelEndpoint({ ...config, llm_api_key: 'k' })).toEqual({ endpoint: '/a', apiKey: 'k' });
        expect(modelEndpoint({ llm_models: [{ value: 'a', endpoint: '/a' }] })).toEqual({ endpoint: '/a', apiKey: undefined });
    });
    it('takes no key from llm_models once llm_endpoint is set', () => {
        expect(modelEndpoint({ llm_endpoint: '/e', llm_models: [{ endpoint: '/a', api_key: 'old' }] }))
            .toEqual({ endpoint: '/e', apiKey: undefined });
    });
    it('is null with no endpoint', () => {
        expect(modelEndpoint({})).toBeNull();
        expect(modelEndpoint({ llm_models: [{ value: 'm' }] })).toBeNull();
        expect(modelEndpoint()).toBeNull();
    });
});

describe('modelsFromTierList (#444, glen#542)', () => {
    it('lists the proxy models in its order, with their settings from the list', () => {
        const list = tierList({ data: [
            { id: 'glm-5' },
            { id: 'deepseek-v4-flash', default: true, settings: { label: 'NRP DeepSeek V4 Flash', temperature: 0.6, max_tokens: 4096 } },
            { id: 'kimi', settings: { label: 'Kimi K2', reasoning_toggle: true, prompt_cache: true } },
            { id: 'bad', settings: ['not', 'an', 'object'] },
            { id: 'odd', settings: null },
        ] });
        const { models } = modelsFromTierList(list, { endpoint: '/api/llm' });
        expect(models.map(m => m.value)).toEqual(['glm-5', 'deepseek-v4-flash', 'kimi', 'bad', 'odd']);
        expect(models[0]).toEqual({ value: 'glm-5', label: 'glm-5', endpoint: '/api/llm' });
        expect(models[1]).toEqual({ value: 'deepseek-v4-flash', label: 'NRP DeepSeek V4 Flash', temperature: 0.6, max_tokens: 4096, endpoint: '/api/llm' });
        expect(models[2]).toMatchObject({ label: 'Kimi K2', reasoning_toggle: true, prompt_cache: true });
        expect(models[3]).toEqual({ value: 'bad', label: 'bad', endpoint: '/api/llm' });
        expect(models[4]).toEqual({ value: 'odd', label: 'odd', endpoint: '/api/llm' });
    });

    it('starts on the proxy\'s default_model, then the flagged default, then the first model', () => {
        expect(modelsFromTierList(tierList(), { endpoint: '/e' }).selected).toBe('deepseek-v4-flash');
        expect(modelsFromTierList(tierList({ default_model: undefined }), { endpoint: '/e' }).selected).toBe('deepseek-v4-flash');
        expect(modelsFromTierList(tierList({ default_model: 'gone', data: [{ id: 'a' }, { id: 'b' }] }), { endpoint: '/e' }).selected).toBe('a');
    });

    it('carries the fetching key, or none', () => {
        expect(modelsFromTierList(tierList(), { endpoint: '/e', apiKey: 'k' }).models.every(m => m.api_key === 'k')).toBe(true);
        expect(modelsFromTierList(tierList(), { endpoint: '/e' }).models.some(m => 'api_key' in m)).toBe(false);
    });

    it('never takes an id, endpoint or key from the proxy settings', () => {
        const list = tierList({ data: [{ id: 'a', settings: { value: 'b', endpoint: 'https://evil', api_key: 'x' } }] });
        expect(modelsFromTierList(list, { endpoint: '/e' }).models[0]).toEqual({ value: 'a', label: 'a', endpoint: '/e' });
    });

    it('ignores a plain /models list with no tier, and empty or malformed lists', () => {
        expect(modelsFromTierList({ data: [{ id: 'a' }] }, { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(tierList({ data: [] }), { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(tierList({ data: [{}, { id: 7 }] }), { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(null, { endpoint: '/e' })).toBeNull();
    });

    it('skips duplicate ids', () => {
        expect(modelsFromTierList(tierList({ data: [{ id: 'a' }, { id: 'a' }] }), { endpoint: '/e' }).models).toHaveLength(1);
    });
});

describe('applyProxyModelList (glen#542)', () => {
    it('sets llm_models and llm_model from the list alone; the app\'s own names are ignored', async () => {
        const config = { llm_endpoint: '/api/llm', llm_models: [{ value: 'kimi', label: 'App label', temperature: 0.1 }], llm_model: 'kimi' };
        const f = okFetch(tierList());
        expect(await applyProxyModelList(config, { fetchImpl: f })).toBe('public');
        expect(f.mock.calls[0][0]).toBe('/api/llm/models');
        expect(f.mock.calls[0][1].headers).toEqual({});
        expect(config.llm_models.map(m => m.value)).toEqual(['glm-5', 'deepseek-v4-flash', 'kimi']);
        expect(config.llm_models[2]).toEqual({ value: 'kimi', label: 'kimi', endpoint: '/api/llm' });
        expect(config.llm_model).toBe('deepseek-v4-flash');
    });

    it('sends llm_api_key when a host sets one', async () => {
        const config = { llm_endpoint: 'https://proxy/v1', llm_api_key: 'k' };
        const f = okFetch(tierList());
        await applyProxyModelList(config, { fetchImpl: f });
        expect(f.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer k' });
        expect(config.llm_models.every(m => m.api_key === 'k')).toBe(true);
    });

    it('keeps an old-form config\'s app token as the bearer, on /models and on chat requests', async () => {
        // bosl-high-seas-private, naturetrace and tpl-internal: nginx returns 403
        // unless the bearer equals APP_TOKEN, today in llm_models[0].api_key.
        const config = { llm_models: [{ value: 'old-name', endpoint: '/api/llm', api_key: 'APP_TOKEN' }] };
        const f = okFetch(tierList());
        await applyProxyModelList(config, { fetchImpl: f });
        expect(f.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer APP_TOKEN' });
        expect(config.llm_models.every(m => m.api_key === 'APP_TOKEN')).toBe(true);

        const agent = new Agent(config, { getToolsForLLM: () => [] });
        global.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
        }));
        await agent.processMessage('q');
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/llm/chat/completions');
        expect(opts.headers.Authorization).toBe('Bearer APP_TOKEN');
        expect(JSON.parse(opts.body).model).toBe('deepseek-v4-flash');
    });

    it('sends no Authorization header on chat requests when there is no key', async () => {
        const config = { llm_endpoint: '/api/llm' };
        await applyProxyModelList(config, { fetchImpl: okFetch(tierList()) });
        const agent = new Agent(config, { getToolsForLLM: () => [] });
        global.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
        }));
        await agent.processMessage('q');
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    it('throws ModelListError, leaving the config alone, when the service cannot be reached or answers wrongly', async () => {
        const config = { llm_endpoint: '/api/llm', llm_models: [{ value: 'm', endpoint: '/api/llm' }], llm_model: 'm' };
        const before = structuredClone(config);
        for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error('down'); }, okFetch({ data: [{ id: 'x' }] })]) {
            const err = await applyProxyModelList(config, { fetchImpl }).catch(e => e);
            expect(err).toBeInstanceOf(ModelListError);
            expect(err.code).toBe('model-list-unavailable');
        }
        expect(config).toEqual(before);
    });

    it('throws ModelListError without fetching when no endpoint is configured', async () => {
        const f = okFetch(tierList());
        await expect(applyProxyModelList({}, { fetchImpl: f })).rejects.toBeInstanceOf(ModelListError);
        expect(f).not.toHaveBeenCalled();
    });
});

describe('buildUserModels (#443)', () => {
    const llm = {
        default_endpoint: 'https://proxy.example/v1',
        models: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', reasoning_toggle: true }],
    };

    it('is null without a key', () => {
        expect(buildUserModels(llm, { endpoint: 'x' })).toBeNull();
    });

    it('uses the app list with the user key and endpoint when no model is saved', () => {
        const r = buildUserModels(llm, { apiKey: 'k', endpoint: 'https://mine/v1' });
        expect(r.llm_models.map(m => m.value)).toEqual(['a', 'b']);
        expect(r.llm_models.every(m => m.endpoint === 'https://mine/v1' && m.api_key === 'k')).toBe(true);
        expect(r.llm_model).toBe('a');
    });

    it('falls back to default_endpoint, then OpenRouter', () => {
        expect(buildUserModels(llm, { apiKey: 'k' }).llm_models[0].endpoint).toBe('https://proxy.example/v1');
        expect(buildUserModels({}, { apiKey: 'k' }).llm_models[0].endpoint).toBe('https://openrouter.ai/api/v1');
    });

    it('puts a saved model id first and selects it, keeping the app list as suggestions', () => {
        const r = buildUserModels(llm, { apiKey: 'k', model: ' anthropic/claude-x ' });
        expect(r.llm_models.map(m => m.value)).toEqual(['anthropic/claude-x', 'a', 'b']);
        expect(r.llm_models[0]).toMatchObject({ label: 'anthropic/claude-x', api_key: 'k' });
        expect(r.llm_model).toBe('anthropic/claude-x');
    });

    it('keeps the app entry\'s settings when the saved id is in the app list', () => {
        const r = buildUserModels(llm, { apiKey: 'k', model: 'b' });
        expect(r.llm_models.map(m => m.value)).toEqual(['b', 'a']);
        expect(r.llm_models[0]).toMatchObject({ label: 'B', reasoning_toggle: true });
    });

    it('offers Auto when the app lists no models and none is saved', () => {
        expect(buildUserModels({}, { apiKey: 'k' }).llm_models.map(m => m.value)).toEqual(['auto']);
        expect(buildUserModels({}, { apiKey: 'k', model: 'x' }).llm_models.map(m => m.value)).toEqual(['x']);
    });

    it('gives the transcription model the user key and endpoint unless it sets its own', () => {
        const r = buildUserModels({ transcription_model: { value: 'gemma-small' } }, { apiKey: 'k', endpoint: 'https://e' });
        expect(r.transcription_model).toEqual({ value: 'gemma-small', endpoint: 'https://e', api_key: 'k' });
        const own = buildUserModels({ transcription_model: { value: 't', endpoint: 'https://t', api_key: 'tk' } }, { apiKey: 'k' });
        expect(own.transcription_model).toMatchObject({ endpoint: 'https://t', api_key: 'tk' });
    });
});

describe('loadUserSettings', () => {
    it('reads the three keys, empty when missing or storage throws', () => {
        const store = { [STORAGE_KEY_API]: 'k', [STORAGE_KEY_ENDPOINT]: 'e', [STORAGE_KEY_MODEL]: 'm' };
        expect(loadUserSettings({ getItem: k => store[k] ?? null })).toEqual({ apiKey: 'k', endpoint: 'e', model: 'm' });
        expect(loadUserSettings({ getItem: () => { throw new Error('blocked'); } })).toEqual({ apiKey: '', endpoint: '', model: '' });
    });
});

describe('fetchModelIds', () => {
    it('returns ids from any OpenAI-style list, empty on failure', async () => {
        expect(await fetchModelIds('https://openrouter.ai/api/v1', { fetchImpl: okFetch({ data: [{ id: 'a' }, { id: 'b' }, {}] }) }))
            .toEqual(['a', 'b']);
        expect(await fetchModelIds('https://x', { fetchImpl: async () => ({ ok: false }) })).toEqual([]);
    });
});
