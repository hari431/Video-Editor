// src/config/ads.js — Phase 8A AdSense preparation
// Environment/configuration layer for future Google AdSense.
// Keeps Google identifiers outside application logic; default keeps live ads disabled.
// Placeholder mode is used so tests can verify placement without contacting Google.

export function getAdsConfig() {
  return {
    // Master switch — live ads only when explicitly enabled AND identifiers present
    enabled: process.env.ADSENSE_ENABLED === 'true',
    // Publisher/client ID (e.g., ca-pub-XXXXXXXXXXXX). Do not hard-code real value.
    clientId: (process.env.ADSENSE_CLIENT_ID || process.env.GOOGLE_ADSENSE_CLIENT_ID || '').trim(),
    // Default ad slot ID (future per-slot IDs can be added)
    slotId: (process.env.ADSENSE_SLOT_ID || process.env.GOOGLE_ADSENSE_SLOT_ID || '').trim(),
    // Optional per-slot map (keeps identifiers outside logic)
    slots: {
      'home-top': (process.env.ADSENSE_SLOT_HOME || process.env.ADSENSE_SLOT_ID || '').trim(),
      'query-top': (process.env.ADSENSE_SLOT_QUERY || process.env.ADSENSE_SLOT_ID || '').trim(),
      'watch-top': (process.env.ADSENSE_SLOT_WATCH || process.env.ADSENSE_SLOT_ID || '').trim(),
      'browse-top': (process.env.ADSENSE_SLOT_BROWSE || process.env.ADSENSE_SLOT_ID || '').trim(),
      'item-top': (process.env.ADSENSE_SLOT_ITEM || process.env.ADSENSE_SLOT_ID || '').trim(),
      'content-top': (process.env.ADSENSE_SLOT_ID || '').trim(),
    }
  };
}

// Live ads are only allowed when enabled AND required identifiers present.
// Default: disabled (no env set → false)
export function isLiveAdsEnabled() {
  const cfg = getAdsConfig();
  return cfg.enabled === true && !!cfg.clientId && !!cfg.slotId;
}

// For tests: helper to check if placeholder mode (live disabled)
export function isPlaceholderMode() {
  return !isLiveAdsEnabled();
}
