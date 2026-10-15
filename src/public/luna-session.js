/* Luna Beta shared session logic — used by the /luna page AND the floating widget.
 *
 * Plain classic script (no modules, no dependencies): exposes window.LunaSession.
 * The API key is ONLY ever:
 *   - held in the caller's page-memory session object,
 *   - sent inside POST JSON bodies to /api/luna/*,
 *   - cleared via session.end() / clearKey() / page unload hooks.
 * This module never persists, logs, or retains any key. It keeps no key
 * reference after a call returns.
 */
(function (root) {
  'use strict';

  function fetchImplOf(provided) {
    if (provided) return provided;
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    throw new Error('Network unavailable.');
  }

  async function readJsonSafe(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  /** Key-free provider catalog. Single source of truth stays server-side. */
  async function fetchProviderCatalog(fetchImpl) {
    const response = await fetchImplOf(fetchImpl)('/api/luna/providers', {
      headers: { Accept: 'application/json' }
    });
    const data = await readJsonSafe(response);
    if (!response.ok || !data || data.ok !== true || !Array.isArray(data.providers) || !data.providers.length) {
      throw new Error((data && data.error) || 'Provider catalog unavailable.');
    }
    return data.providers;
  }

  /**
   * Validate a runtime key through the existing endpoint.
   * Returns { provider, model }. Never returns or retains the key.
   */
  async function validateConnection({ provider, model, apiKey }, fetchImpl) {
    if (!provider) throw new Error('Select a provider first.');
    if (!model) throw new Error('No model is configured for this provider.');
    if (!apiKey) throw new Error('Enter an API key first.');
    const response = await fetchImplOf(fetchImpl)('/api/luna/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, api_key: apiKey })
    });
    const data = await readJsonSafe(response);
    if (!response.ok || !data || data.ok !== true) {
      throw new Error((data && data.error) || 'Validation failed.');
    }
    return { provider: data.provider, model: data.model };
  }

  /**
   * Send a chat query through the existing endpoint. Provider fields travel
   * only when the session is an active AI session holding a runtime key.
   */
  async function sendLunaQuery({ query, history, contextPath, topK, session }, fetchImpl) {
    const body = {
      query,
      history: Array.isArray(history) ? history.slice(-20) : [],
      top_k: topK || 5,
      context_path: contextPath || ''
    };
    if (session && session.mode === 'ai' && session.apiKey) {
      body.provider = session.provider;
      body.model = session.model;
      body.api_key = session.apiKey;
    }
    const response = await fetchImplOf(fetchImpl)('/api/luna/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await readJsonSafe(response);
    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || 'Luna request failed.');
    }
    return data;
  }

  /**
   * Page-memory session state. No storage, no cookies, no URLs — callers keep
   * the returned object for the life of the page only.
   */
  function createSession() {
    const state = {
      mode: null, // null | 'ai' | 'local'
      provider: '',
      providerLabel: '',
      model: '',
      apiKey: '',
      validated: null // { provider, model } snapshot of last successful Test Connection
    };
    return {
      state,
      markValidated(provider, model) {
        state.validated = { provider, model };
      },
      invalidate() {
        state.validated = null;
      },
      isValidated(provider, model, hasKey) {
        return Boolean(
          state.validated &&
          state.validated.provider === provider &&
          state.validated.model === model &&
          hasKey
        );
      },
      startAi({ provider, providerLabel, model, apiKey }) {
        state.mode = 'ai';
        state.provider = provider;
        state.providerLabel = providerLabel || provider;
        state.model = model;
        state.apiKey = apiKey;
      },
      startLocal() {
        state.mode = 'local';
        state.provider = '';
        state.providerLabel = '';
        state.model = '';
        state.apiKey = '';
        state.validated = null;
      },
      clearKey(keyInput) {
        state.apiKey = '';
        if (keyInput) keyInput.value = '';
      },
      end(keyInput) {
        state.mode = null;
        state.provider = '';
        state.providerLabel = '';
        state.model = '';
        state.apiKey = '';
        state.validated = null;
        if (keyInput) keyInput.value = '';
      }
    };
  }

  function findProvider(catalog, id) {
    for (const p of catalog || []) {
      if (p && p.id === id) return p;
    }
    return null;
  }

  function makeOption(doc, value, text, selected) {
    const opt = doc.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (selected) opt.selected = true;
    return opt;
  }

  function populateProviderSelect(select, catalog) {
    const doc = select.ownerDocument;
    select.innerHTML = '';
    for (const p of catalog || []) {
      select.appendChild(makeOption(doc, p.id, p.label, false));
    }
  }

  /**
   * Fill the model dropdown from the catalog entry.
   * Returns { hasModels, showCustom } so callers never invent model names.
   */
  function populateModelSelect(select, provider) {
    const doc = select.ownerDocument;
    select.innerHTML = '';
    const models = (provider && Array.isArray(provider.models) && provider.models) || [];
    if (!models.length) {
      select.appendChild(makeOption(doc, '', 'No models configured for this provider', true));
      return { hasModels: false, showCustom: false };
    }
    for (const name of models) {
      select.appendChild(makeOption(doc, name, name, name === provider.defaultModel));
    }
    return { hasModels: true, showCustom: Boolean(provider.acceptsCustomModel) };
  }

  function effectiveModel({ modelValue, customValue, provider }) {
    const custom = String(customValue || '').trim();
    if (provider && provider.acceptsCustomModel && custom) return custom;
    return String(modelValue || '').trim();
  }

  function keyLinkFor(provider) {
    if (!provider) return { href: '#', text: 'Get API Key' };
    const article = /^[aeiou]/i.test(provider.label) ? 'an' : 'a';
    return { href: provider.keyUrl, text: 'Get ' + article + ' ' + provider.label + ' API key' };
  }

  /** Clear the runtime key when the page session ends. */
  function attachSessionCleanup(sessionApi, keyInput) {
    const clear = () => sessionApi.clearKey(keyInput);
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pagehide', clear);
      root.addEventListener('beforeunload', clear);
    }
  }

  root.LunaSession = {
    fetchProviderCatalog,
    validateConnection,
    sendLunaQuery,
    createSession,
    findProvider,
    populateProviderSelect,
    populateModelSelect,
    effectiveModel,
    keyLinkFor,
    attachSessionCleanup
  };
})(typeof window !== 'undefined' ? window : globalThis);
