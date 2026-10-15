// src/library/ad-slot.js — Phase 7 & 8A advertising placement framework
// Reusable, server-side-controlled ad slot / component.
// - Receives current authenticated user and content path
// - Uses existing isAdVisibleForUser(user, contentPath) as single authority
// - Renders empty/no-op when ads not allowed
// - Renders clearly identifiable placeholder/container when ads allowed
// Do NOT make client decide eligibility. No live Google AdSense yet.
// Phase 8A: Prepared for future Google AdSense — live code only when showAd===true AND isLiveAdsEnabled() (config).
// Google identifiers are outside logic (src/config/ads.js, env vars). Default keeps live disabled (placeholder mode).

import { isAdVisibleForUser } from './ad-visibility.js';
import { getAdsConfig, isLiveAdsEnabled } from '../config/ads.js';

// Single, reusable decision wrapper. Keeps eligibility logic centralized. isAdVisibleForUser remains single authority.
export function shouldShowAdSlot(user, contentPath, canAccessFn) {
  return isAdVisibleForUser(user, contentPath, canAccessFn);
}

// Returns placeholder HTML when allowed, otherwise empty string.
// When live AdSense is enabled (future, via env), returns prepared container instead of placeholder.
// Server-side only; no query params / cookies trust.
export function renderAdSlot(user, contentPath, slotId = 'content-top') {
  if (!shouldShowAdSlot(user, contentPath)) return '';
  // Phase 8A: live AdSense only when server-side eligible AND config enabled with identifiers.
  // Never load on PDFs/dumps/restricted/OWNER/ADMIN — already filtered by shouldShowAdSlot.
  // For preparation, we keep placeholder mode when live disabled (default). No external network call.
  // Future live mode will use identifiers from src/config/ads.js (env) without hard-coding.
  if (isLiveAdsEnabled()) {
    const cfg = getAdsConfig();
    const slot = cfg.slots[slotId] || cfg.slotId || '';
    // Prepared container — identifiable, easy to replace with real AdSense.
    // Intentionally no external script src here to keep tests deterministic and live disabled by default.
    // Future implementation can replace this placeholder with AdSense markup using cfg.clientId/slot.
    return `<div class="ad-slot ad-slot--prepared" data-ad-slot="${slotId}" data-testid="ad-slot" data-adsense="prepared" data-ad-client="${cfg.clientId}" data-ad-slot-id="${slot}" aria-label="Advertisement slot prepared for AdSense" style="border:1px dashed #a5b4fc;background:#eef2ff;padding:12px;text-align:center;border-radius:8px;margin:16px 0;"><small class="muted">Ad slot prepared — AdSense configured</small><div style="display:block" data-ad-client="${cfg.clientId}" data-ad-slot="${slot}"></div></div>`;
  }
  // When live ads are disabled, render nothing (no development placeholder)
  return '';
}

// Returns context object for EJS templates (avoids duplicating logic in views).
export function getAdSlotContext(user, contentPath, slotId = 'content-top') {
  const showAd = shouldShowAdSlot(user, contentPath);
  return {
    showAd,
    slotId,
    html: showAd ? renderAdSlot(user, contentPath, slotId) : ''
  };
}
