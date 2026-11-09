import { describe, it, expect, vi } from 'vitest';
import {
    modelsUrl, fetchModelList, sharedEndpoint, modelsFromTierList,
    applyProxyModelList, buildUserModels, loadUserSettings, fetchModelIds,
    STORAGE_KEY_API, STORAGE_KEY_ENDPOINT, STORAGE_KEY_MODEL,
} from '../src/llm-models.js';

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

describe('sharedEndpoint', () => {
    it('finds the endpoint and key all models share', () => {
        expect(sharedEndpoint([{ endpoint: '/api/llm' }, { endpoint: '/api/llm' }]))
            .toEqual({ endpoint: '/api/llm', apiKey: undefined });
    });
    it('is null when models differ, lack an endpoint, or are absent', () => {
        expect(sharedEndpoint([{ endpoint: '/a' }, { endpoint: '/b' }])).toBeNull();
        expect(sharedEndpoint([{ endpoint: '/a', api_key: 'x' }, { endpoint: '/a', api_key: 'y' }])).toBeNull();
        expect(sharedEndpoint([{ value: 'm' }])).toBeNull();
        expect(sharedEndpoint([])).toBeNull();
        expect(sharedEndpoint(undefined)).toBeNull();
    });
});

describe('modelsFromTierList (#444)', () => {
    const config = [
        { value: 'kimi', label: 'Kimi K2', endpoint: '/api/llm', reasoning_toggle: true, temperature: 0.3 },
        { value: 'gpt-paid', label: 'Paid model', endpoint: '/api/llm' },
    ];

    it('lists the proxy models in its order, with config settings matched by id', () => {
        const { models } = modelsFromTierList(tierList(), config, { endpoint: '/api/llm' });
        expect(models.map(m => m.value)).toEqual(['glm-5', 'deepseek-v4-flash', 'kimi']);
        expect(models[2]).toMatchObject({ label: 'Kimi K2', reasoning_toggle: true, temperature: 0.3, endpoint: '/api/llm' });
        expect(models[0]).toEqual({ value: 'glm-5', label: 'glm-5', endpoint: '/api/llm' });
    });

    it('drops configured models the tier does not list', () => {
        const { models } = modelsFromTierList(tierList(), config, { endpoint: '/api/llm' });
        expect(models.find(m => m.value === 'gpt-paid')).toBeUndefined();
    });

    it('starts on the proxy\'s default_model', () => {
        expect(modelsFromTierList(tierList(), config, { endpoint: '/api/llm' }).selected).toBe('deepseek-v4-flash');
    });

    it('falls back to the flagged default, then the first model', () => {
        expect(modelsFromTierList(tierList({ default_model: undefined }), [], { endpoint: '/e' }).selected).toBe('deepseek-v4-flash');
        expect(modelsFromTierList(tierList({ default_model: 'gone', data: [{ id: 'a' }, { id: 'b' }] }), [], { endpoint: '/e' }).selected).toBe('a');
    });

    it('carries the fetching key, and never a stale per-model key', () => {
        const withKey = modelsFromTierList(tierList(), [{ value: 'kimi', api_key: 'old' }], { endpoint: '/e', apiKey: 'k' });
        expect(withKey.models.every(m => m.api_key === 'k')).toBe(true);
        const noKey = modelsFromTierList(tierList(), [{ value: 'kimi', api_key: 'old' }], { endpoint: '/e' });
        expect(noKey.models.some(m => 'api_key' in m)).toBe(false);
    });

    it('ignores a plain /models list with no tier, and empty or malformed lists', () => {
        expect(modelsFromTierList({ data: [{ id: 'a' }] }, [], { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(tierList({ data: [] }), [], { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(tierList({ data: [{}, { id: 7 }] }), [], { endpoint: '/e' })).toBeNull();
        expect(modelsFromTierList(null, [], { endpoint: '/e' })).toBeNull();
    });

    it('skips duplicate ids', () => {
        const { models } = modelsFromTierList(tierList({ data: [{ id: 'a' }, { id: 'a' }] }), [], { endpoint: '/e' });
        expect(models).toHaveLength(1);
    });
});

describe('applyProxyModelList', () => {
    it('replaces llm_models and llm_model from the tier list; the proxy default beats the app\'s llm_model', async () => {
        const config = { llm_models: [{ value: 'kimi', endpoint: '/api/llm' }], llm_model: 'kimi' };
        const tier = await applyProxyModelList(config, { fetchImpl: okFetch(tierList()) });
        expect(tier).toBe('public');
        expect(config.llm_models.map(m => m.value)).toEqual(['glm-5', 'deepseek-v4-flash', 'kimi']);
        expect(config.llm_model).toBe('deepseek-v4-flash');
    });

    it('leaves the config alone when the fetch fails or the endpoint is not the proxy', async () => {
        const original = [{ value: 'm', endpoint: '/api/llm' }];
        const a = { llm_models: [...original], llm_model: 'm' };
        expect(await applyProxyModelList(a, { fetchImpl: async () => ({ ok: false }) })).toBeNull();
        expect(a).toEqual({ llm_models: original, llm_model: 'm' });
        const b = { llm_models: [...original] };
        expect(await applyProxyModelList(b, { fetchImpl: okFetch({ data: [{ id: 'x' }] }) })).toBeNull();
        expect(b.llm_models).toEqual(original);
    });

    it('does not fetch when models use different endpoints or none are set', async () => {
        const f = okFetch(tierList());
        await applyProxyModelList({ llm_models: [{ value: 'a', endpoint: '/x' }, { value: 'b', endpoint: '/y' }] }, { fetchImpl: f });
        await applyProxyModelList({}, { fetchImpl: f });
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
