// Reference Path / Pin Generator — authoring convenience only (runtime UI state).
//
// Pure helpers: no database, no filesystem, no session, no persistence.
// They only shape strings from the CURRENT item's canonical library path.
// Storage/resolution/parsing of Pins is unchanged (see ./pinned.js).
import { contentRouteForPath } from './local.js';

// Canonical reference path for the item currently being viewed.
// Built from the exact library path (never filename search/fuzzy matching),
// prefixed with the existing route for that path (/query/, /external/, /item/…).
// Displayed with readable spaces (e.g. "/query/Premium/Policy Center/..."),
// matching the Pin-reference format the parser already accepts.
export function pinReferencePath(itemPath) {
  if (typeof itemPath !== 'string' || !itemPath) return '';
  return contentRouteForPath(itemPath) + itemPath;
}

// Complete Pin string in the existing canonical syntax:
//   Normal:  Pinned: <Name> | <Path>
//   Premium: Pinned: Premium | <Name> | <Path>
// Mirrored by the client-side generator script (partials/pin-generator.ejs);
// keep both in sync.
export function buildPinString({ access = 'normal', name = '', path = '' } = {}) {
  const title = String(name ?? '').trim();
  const url = String(path ?? '').trim();
  if (String(access ?? '').toLowerCase() === 'premium') {
    return `Pinned: Premium | ${title} | ${url}`;
  }
  return `Pinned: ${title} | ${url}`;
}
