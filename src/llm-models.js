/**
 * llm-models.js — Which models the picker offers.
 *
 * Issue numbers refer to SchmidtDSE/glen.
 *
 * Two sources besides the app's own `llm_models`:
 *
 * - The open-llm-proxy's tier list (#444). Each app's proxy key carries a tier
 *   (public or private), and `GET <endpoint>/models` returns that tier's
 *   models with a `tier` and `default_model`. A model outside the tier gets a
 *   403, so when the proxy answers, its list decides what the picker shows and
 *   `llm_models` only supplies per-model settings, matched by id.
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
 * failure (network, HTTP error, bad JSON, no `data` array, timeout), so a
 * caller can always fall back to its configured list.
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
 * The one endpoint (and key) every configured model uses, or null when the
 * models disagree. Only a single shared endpoint can be asked for "the" list.
 */
export function sharedEndpoint(models) {
    if (!Array.isArray(models) || models.length === 0) return null;
    const { endpoint, api_key } = models[0];
    if (!endpoint) return null;
    const same = models.every(m => m.endpoint === endpoint && (m.api_key || '') === (api_key || ''));
    return same ? { endpoint, apiKey: api_key } : null;
}

/**
 * Build the picker from the proxy's tier list.
 *
 * @param {Object} list  - `{tier, default_model, data: [{id, ...}]}` from the proxy
 * @param {Array} configModels - the app's `llm_models`, used for per-model
 *   settings (label, reasoning_toggle, sampling, …) matched by id; entries the
 *   proxy does not list are dropped.
 * @param {Object} opts
 * @param {string} opts.endpoint - the endpoint the list came from
 * @param {string} [opts.apiKey]  - the key used to fetch it, if any
 * @returns {{models: Array, selected: string}|null} null when the response is
 *   not a proxy tier list or lists nothing.
 */
export function modelsFromTierList(list, configModels, { endpoint, apiKey } = {}) {
    // Only the proxy's tier list replaces the config. A plain OpenAI-style
    // /models (vLLM, OpenRouter) has no `tier` and may list hundreds of models.
    if (!list || typeof list.tier !== 'string' || !Array.isArray(list.data)) return null;
    const byId = new Map((configModels || []).map(m => [m.value, m]));
    const models = [];
    const seen = new Set();
    for (const entry of list.data) {
        const id = entry?.id;
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        const settings = byId.get(id) || {};
        const model = { ...settings, value: id, label: settings.label || id, endpoint };
        if (apiKey) model.api_key = apiKey;
        else delete model.api_key;
        models.push(model);
    }
    if (models.length === 0) return null;
    const ids = new Set(models.map(m => m.value));
    const flagged = list.data.find(e => e?.default === true)?.id;
    // The proxy owns one default per tier, so the app's llm_model does not
    // override it; llm_model applies only when the list cannot be fetched.
    const selected = [list.default_model, flagged].find(id => ids.has(id)) || models[0].value;
    return { models, selected };
}

/**
 * Ask the proxy for this app's tier list and apply it to `config` in place
 * (`llm_models`, `llm_model`). Leaves the config untouched when the models do
 * not share one endpoint, or the endpoint is not the proxy, or the fetch
 * fails. Returns the tier name when applied, else null.
 */
export async function applyProxyModelList(config, { fetchImpl } = {}) {
    const shared = sharedEndpoint(config.llm_models);
    if (!shared) return null;
    const list = await fetchModelList(shared.endpoint, { apiKey: shared.apiKey, fetchImpl });
    const result = modelsFromTierList(list, config.llm_models, {
        endpoint: shared.endpoint,
        apiKey: shared.apiKey,
    });
    if (!result) return null;
    config.llm_models = result.models;
    config.llm_model = result.selected;
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
