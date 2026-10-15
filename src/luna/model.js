/**
 * Luna V2 provider-neutral model interface.
 *
 * The rest of Luna must only use:
 *
 *   model.generate({ messages, evidence, tools, model, apiKey })
 *
 * and never touch provider-specific request/response formats.
 * All Gemini / OpenRouter details live under src/luna/providers/.
 */

export const SUPPORTED_PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    // Stable generateContent models (Gemini 2.5 family current; 2.0 kept working).
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite'
    ],
    // All configured Gemini models accept image input (verified against the
    // official model docs: text+image+video+audio in, text out).
    visionModels: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite'
    ],
    acceptsCustomModel: false
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openrouter/auto',
    // OpenRouter is a gateway: any provider-side model slug is routed through.
    models: ['openrouter/auto'],
    // Vision depends on the routed-to model, so capability is attempted and
    // incapable models get a clear error from the adapter (see supportsVision).
    visionModels: [],
    acceptsCustomModel: true
  }
};

/** Public, key-free provider catalog for the Beta setup UI. */
export function listProviders() {
  return Object.values(SUPPORTED_PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    keyUrl: p.keyUrl,
    defaultModel: p.defaultModel,
    models: [...p.models],
    visionModels: [...(p.visionModels || [])],
    acceptsCustomModel: Boolean(p.acceptsCustomModel)
  }));
}

/**
 * Whether `model` can receive image attachments.
 * Gemini is decided from the verified catalog; OpenRouter is a gateway, so
 * the request is attempted and incapable models receive a clear safe error.
 */
export function supportsVision(provider, model) {
  const id = normalizeProvider(provider);
  const name = String(model || '').trim() || defaultModelFor(id);
  if (id === 'openrouter') return true;
  return (SUPPORTED_PROVIDERS[id].visionModels || []).includes(name);
}

export function isSupportedProvider(provider) {
  return Object.hasOwn(SUPPORTED_PROVIDERS, String(provider || '').toLowerCase().trim());
}

export function normalizeProvider(provider) {
  const id = String(provider || '').toLowerCase().trim();
  if (!isSupportedProvider(id)) throw new Error(`Unsupported AI provider: ${String(provider || '')}.`);
  return id;
}

export function defaultModelFor(provider) {
  return SUPPORTED_PROVIDERS[normalizeProvider(provider)].defaultModel;
}

export function keyUrlFor(provider) {
  return SUPPORTED_PROVIDERS[normalizeProvider(provider)].keyUrl;
}

/**
 * True when `model` may be used with `provider`.
 * Gemini is allowlisted to the configured models; OpenRouter is a gateway
 * and routes any non-empty provider-side model slug.
 */
export function isSupportedModel(provider, model) {
  const id = normalizeProvider(provider);
  const name = String(model || '').trim();
  if (!name) return false;
  if (SUPPORTED_PROVIDERS[id].acceptsCustomModel) return true;
  return SUPPORTED_PROVIDERS[id].models.includes(name);
}

/** Resolve + validate the model, defaulting when blank. Never includes the key. */
export function resolveModel(provider, model) {
  const id = normalizeProvider(provider);
  const name = String(model || '').trim() || defaultModelFor(id);
  if (!isSupportedModel(id, name)) {
    const allowed = SUPPORTED_PROVIDERS[id].models.join(', ');
    throw new Error(`Unsupported model for ${id}: "${name.slice(0, 80)}". Choose one of: ${allowed}.`);
  }
  return name;
}

function requireApiKey(apiKey, provider) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error(`An API key for ${provider} is required (runtime only, never stored).`);
  }
  return apiKey.trim();
}

async function loadAdapter(provider) {
  const id = normalizeProvider(provider);
  if (id === 'gemini') return import('./providers/gemini.js');
  if (id === 'openrouter') return import('./providers/openrouter.js');
  throw new Error(`Unsupported AI provider: ${id}.`);
}

/**
 * Provider-neutral generation.
 * @param {object} opts
 * @param {string} opts.provider 'gemini' | 'openrouter'
 * @param {string} [opts.model] provider-specific model id
 * @param {string} opts.apiKey runtime-only key; never logged/persisted
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {Array} [opts.evidence] structured evidence items
 * @returns {Promise<{text:string, model:string, provider:string, usage?:object}>}
 */
export async function generate({ provider, model, apiKey, messages, evidence = [] }) {
  const id = normalizeProvider(provider);
  const key = requireApiKey(apiKey, id);
  const modelName = resolveModel(id, model);
  const adapter = await loadAdapter(id);
  // NOTE: never log `key` here or in adapters.
  return adapter.generate({ messages, evidence, model: modelName, apiKey: key });
}

/**
 * Minimal validation request (small token footprint) before starting Luna.
 * Returns { ok:true, provider, model } or throws with a redacted error.
 */
export async function validateApiKey({ provider, model, apiKey, fetchImpl = fetch }) {
  const id = normalizeProvider(provider);
  const key = requireApiKey(apiKey, id);
  const modelName = resolveModel(id, model);
  const adapter = await loadAdapter(id);
  return adapter.validate({ model: modelName, apiKey: key, fetchImpl });
}

/** Strip anything that looks like a key from error text (defense in depth). */
export function redactError(message) {
  return String(message || '')
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-(or-)?[0-9A-Za-z\-_]{8,}/g, '[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]');
}

/**
 * HTTP status for a (redacted) validation failure. Kept here so the route
 * and tests share one mapping: 400 bad input, 401 bad key, 429 quota,
 * 503 provider/network unreachable, 502 anything else provider-side.
 */
export function validationHttpStatus(message) {
  const text = String(message || '');
  if (/required/i.test(text)) return 400;
  if (/unsupported/i.test(text)) return 400;
  if (/unknown.*model/i.test(text)) return 400;
  if (/invalid.*api key/i.test(text)) return 401;
  if (/rate limit/i.test(text)) return 429;
  if (/timed out|aborted|fetch failed|network|unavailable|failed \(status 5/i.test(text)) return 503;
  return 502;
}
