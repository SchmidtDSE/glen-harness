/**
 * llm-models.js — Which models the picker offers.
 *
 * Issue numbers refer to SchmidtDSE/glen.
 *
 * Two sources:
 *
 * - The open-llm-proxy's tier list (#444, #542). Each app's proxy key carries
 *   a tier, and `GET <llm_endpoint>/models` returns that tier's models with a
 *   `tier`, a `default_model` and each model's settings. It is the only source
 *   of the list, the default and the settings: apps name no models, and when
 *   the list cannot be fetched there is no fallback.
 * - A bring-your-own-key user's own model id (#443), saved next to their key.
 *   Their key pays, so they may name any model their endpoint serves; the
 *   app's `llm.models` stay as suggestions.
 */

// No Authorization header without a key, so a deployment behind basic auth
// keeps the browser's saved credentials (glen#420).
const bearerHeader = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

export const STORAGE_KEY_API = 'geo-agent-api-key';
export const STORAGE_KEY_ENDPOINT = 'geo-agent-endpoint';
export const STORAGE_KEY_MODEL = 'geo-agent-model';
export const DEFAULT_USER_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * The `/models` URL that sits beside a chat-completions endpoint.
 * `/api/llm` → `/api/llm/models`; `…/v1/chat/completions` → `…/v1/models`.
 */
export function modelsUrl(endpoint) {
    return String(endpoint || '')
        .replace(/\/chat\/completions\/?$/, '')
        .replace(/\/+$/, '') + '/models';
}

/**
 * Fetch an endpoint's model list. Resolves to the parsed body, or null on any
 * failure (network, HTTP error, bad JSON, no `data` array, timeout).
 */
export async function fetchModelList(endpoint, { apiKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    if (!endpoint || typeof fetchImpl !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetchImpl(modelsUrl(endpoint), {
            headers: bearerHeader(apiKey),
            signal: controller?.signal,
        });
        if (!res.ok) return null;
        const body = await res.json();
        return Array.isArray(body?.data) ? body : null;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Thrown by applyProxyModelList when no model list can be had: no endpoint is
 * configured, the model service cannot be reached, or it answers with
 * something that is not open-llm-proxy's tier list. There is no fallback to a
 * list in the app's config (glen#542); the host shows the error, or offers a
 * bring-your-own-key user their own models.
 */
export class ModelListError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'ModelListError';
        this.code = 'model-list-unavailable';
    }
}

/**
 * The model service's endpoint and key, in the usual OpenAI-compatible shape:
 * `llm_endpoint` and an optional `llm_api_key`. With a key, /models and chat
 * requests carry `Authorization: Bearer <key>`; without one they carry no
 * header, so a deployment behind basic auth keeps its saved login (glen#420).
 *
 * During the move to `llm_endpoint`, a config with only `llm_models` uses the
 * first entry's endpoint and key; the entries' names and settings are ignored
 * (glen#542). Apps whose nginx checks the bearer against an app token keep it
 * in that key today.
 */
export function modelEndpoint(config = {}) {
    if (config.llm_endpoint) {
        return { endpoint: config.llm_endpoint, apiKey: config.llm_api_key || undefined };
    }
    const first = config.llm_models?.[0];
    return first?.endpoint
        ? { endpoint: first.endpoint, apiKey: config.llm_api_key || first.api_key || undefined }
        : null;
}

/**
 * Build the picker from the proxy's tier list. The list is the only source:
 * each model's settings (label, reasoning_toggle, sampling, …) come from its
 * entry's `settings` (open-llm-proxy#189), and nothing in the app's config
 * overrides them (glen#542).
 *
 * @param {Object} list  - `{tier, default_model, data: [{id, settings, ...}]}` from the proxy
 * @param {Object} opts
 * @param {string} opts.endpoint - the endpoint the list came from
 * @param {string} [opts.apiKey]  - the key used to fetch it, if any
 * @returns {{models: Array, selected: string}|null} null when the response is
 *   not a proxy tier list or lists nothing.
 */
export function modelsFromTierList(list, { endpoint, apiKey } = {}) {
    // Only the proxy's tier list is accepted. A plain OpenAI-style /models
    // (vLLM, OpenRouter) has no `tier` and may list hundreds of models.
    if (!list || typeof list.tier !== 'string' || !Array.isArray(list.data)) return null;
    const models = [];
    const seen = new Set();
    for (const entry of list.data) {
        const id = entry?.id;
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        const settings = entry.settings && typeof entry.settings === 'object' && !Array.isArray(entry.settings)
            ? entry.settings : {};
        const model = { ...settings, value: id, label: settings.label || id, endpoint };
        if (apiKey) model.api_key = apiKey;
        else delete model.api_key;
        models.push(model);
    }
    if (models.length === 0) return null;
    const ids = new Set(models.map(m => m.value));
    const flagged = list.data.find(e => e?.default === true)?.id;
    const selected = [list.default_model, flagged].find(id => ids.has(id)) || models[0].value;
    return { models, selected };
}

/**
 * Ask the model service for this app's tier list and apply it to `config` in
 * place (`llm_models`, `llm_model`, and `transcription_model` when the list
 * names one). Returns the tier name. Throws a
 * ModelListError when there is no endpoint, the fetch fails, or the answer is
 * not a tier list; the config is then left as it was.
 */
export async function applyProxyModelList(config, { fetchImpl } = {}) {
    const service = modelEndpoint(config);
    if (!service) {
        throw new ModelListError('No model service is configured (llm_endpoint).');
    }
    const list = await fetchModelList(service.endpoint, { apiKey: service.apiKey, fetchImpl });
    if (!list) {
        throw new ModelListError(`The model service at ${service.endpoint} could not be reached.`);
    }
    const result = modelsFromTierList(list, service);
    if (!result) {
        throw new ModelListError(`The model service at ${service.endpoint} did not return a model list for this app.`);
    }
    config.llm_models = result.models;
    config.llm_model = result.selected;
    // The tier's voice-input model (open-llm-proxy#210): callable with the same
    // endpoint and key, though not listed in `data`. A list that names none
    // leaves the config's own transcription_model as it is.
    if (typeof list.transcription_model === 'string' && list.transcription_model) {
        config.transcription_model = { value: list.transcription_model, endpoint: service.endpoint };
        if (service.apiKey) config.transcription_model.api_key = service.apiKey;
    }
    return list.tier;
}

/**
 * Build the bring-your-own-key model list.
 *
 * @param {Object} llmConfig - the app's `llm` block (`models`, `default_endpoint`, `transcription_model`)
 * @param {Object} saved - `{apiKey, endpoint, model}` from localStorage
 * @returns {{llm_models: Array, llm_model: string, transcription_model?: Object}|null}
 *   null when no key is saved.
 */
export function buildUserModels(llmConfig = {}, { apiKey, endpoint, model } = {}) {
    if (!apiKey) return null;
    const ep = endpoint || llmConfig.default_endpoint || DEFAULT_USER_ENDPOINT;
    const custom = typeof model === 'string' ? model.trim() : '';

    const models = (llmConfig.models || []).map(m => ({ ...m, endpoint: ep, api_key: apiKey }));
    if (custom) {
        // The user's own id goes first and starts selected. If the app lists
        // it too, keep that entry's settings (label, reasoning, sampling).
        const i = models.findIndex(m => m.value === custom);
        const entry = i >= 0 ? models.splice(i, 1)[0] : { value: custom, label: custom, endpoint: ep, api_key: apiKey };
        models.unshift(entry);
    }
    if (models.length === 0) {
        models.push({ value: 'auto', label: 'Auto', endpoint: ep, api_key: apiKey });
    }

    const result = { llm_models: models, llm_model: models[0].value };

    // Transcription model for voice input inherits the user's key and (by
    // default) the same endpoint. Either can be overridden per entry.
    if (llmConfig.transcription_model?.value) {
        result.transcription_model = {
            ...llmConfig.transcription_model,
            endpoint: llmConfig.transcription_model.endpoint || ep,
            api_key: llmConfig.transcription_model.api_key || apiKey,
        };
    }
    return result;
}

/** Read the bring-your-own-key settings from storage (localStorage by default). */
export function loadUserSettings(storage = globalThis.localStorage) {
    const get = (k) => { try { return storage?.getItem(k) || ''; } catch { return ''; } };
    return {
        apiKey: get(STORAGE_KEY_API),
        endpoint: get(STORAGE_KEY_ENDPOINT),
        model: get(STORAGE_KEY_MODEL),
    };
}

/**
 * The model ids an endpoint's `/models` lists, for suggestions in the
 * settings panel. Empty on any failure.
 */
export async function fetchModelIds(endpoint, opts) {
    const list = await fetchModelList(endpoint, opts);
    return (list?.data || []).map(e => e?.id).filter(id => typeof id === 'string' && id);
}
