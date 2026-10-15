/**
 * Luna V2 provider-independent retrieval layer.
 * Resolves current file → searches library → reads relevant sections →
 * combines capped evidence. Never sends whole large documents anywhere;
 * callers (agent/model) only receive the capped evidence returned here.
 */
import { findFile, findVideo, findExternal } from '../library/tree.js';
import { contentRouteForPath } from '../library/local.js';
import { canReadPath, filterEvidenceForUser } from './permissions.js';
import { searchLibrary } from './tools/library.js';
import { readDocumentSections } from './tools/documents.js';
import { inspectSpreadsheet } from './tools/spreadsheets.js';
import { describeImage, isImagePath, readImageEvidence } from './tools/images.js';
import { readVideoEvidence, isVideoPath } from './tools/videos.js';
import { searchGuidewireDocs } from './tools/guidewire-docs.js';
import { buildEffectiveQuery, isSummaryQuery } from './conversation.js';

export const MAX_EVIDENCE_ITEMS = 6;
export const MAX_EVIDENCE_CHARS = 12_000;

export function pathFromContextUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (/^https?:/i.test(raw)) raw = new URL(raw).pathname;
  } catch {
    return null;
  }
  const match = raw.match(/^\/(?:query|item|watch|external)\/(.+)$/);
  if (!match) return raw;
  try {
    return match[1].split('/').map(segment => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
}

function hrefFor(relPath) {
  return contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');
}

function isSpreadsheetPath(relPath) {
  return /\.(csv|xlsx|xls)$/i.test(String(relPath || ''));
}

/**
 * Resolve + read the current file with permission checks.
 * Image bytes are attached only when `includeImageBytes` is true — the agent
 * sets it when a vision-capable provider/model is configured. Permission is
 * always verified before any bytes are read.
 */
export async function resolveCurrentFile({ contextPath, tree, user, query = '', includeImageBytes = false }) {
  const normalized = pathFromContextUrl(contextPath);
  if (!normalized) return { normalized: null, result: null, denied: false };
  const node = findFile(tree, normalized) || findVideo(tree, normalized) || findExternal(tree, normalized);
  if (!node) return { normalized, result: null, denied: false };
  if (!(await canReadPath(user, normalized))) return { normalized, result: null, denied: true };

  const title = normalized.split('/').at(-1) || normalized;
  try {
    if (isSpreadsheetPath(normalized)) {
      const { evidence, readable } = await inspectSpreadsheet({ relPath: normalized, node, query });
      const snippet = evidence.map(e => e.content).join('\n\n').slice(0, 20_000);
      return {
        normalized,
        denied: false,
        result: {
          type: 'spreadsheet', title, path: normalized, href: hrefFor(normalized),
          snippet, score: 100, meta: evidence[0]?.metadata || {}
        }
      };
    }
    if (isVideoPath(normalized, node) || node?.type === 'external') {
      const { evidence, readable } = await readVideoEvidence({ relPath: normalized, node, query });
      const snippet = evidence.map(e => e.content).join('\n\n').slice(0, 20_000);
      return {
        normalized,
        denied: false,
        result: {
          type: evidence[0]?.source || 'video', title, path: normalized, href: hrefFor(normalized),
          snippet, score: 100, meta: evidence[0]?.metadata || {}
        }
      };
    }
    if (isImagePath(normalized)) {
      const { evidence } = await readImageEvidence({ relPath: normalized, includeBytes: includeImageBytes });
      const item = evidence[0];
      return {
        normalized,
        denied: false,
        result: {
          type: 'image', title, path: normalized, href: hrefFor(normalized),
          snippet: item.content, score: 100, meta: item.metadata || {},
          attachments: item.attachments || []
        }
      };
    }
    const { evidence, meta, readable } = await readDocumentSections({ relPath: normalized, node, query });
    const snippet = evidence.map(e => e.content).join('\n\n').slice(0, 20_000);
    if (!readable) {
      return {
        normalized,
        denied: false,
        result: {
          type: meta?.type || 'library', title, path: normalized, href: hrefFor(normalized),
          snippet: '', score: 90, meta
        }
      };
    }
    return {
      normalized,
      denied: false,
      result: {
        type: meta?.type || 'library', title, path: normalized, href: hrefFor(normalized),
        snippet, score: 100, meta: meta || {}
      }
    };
  } catch (error) {
    return {
      normalized,
      denied: false,
      result: {
        type: 'library', title, path: normalized, href: hrefFor(normalized),
        snippet: '', score: 90, meta: { readError: error.message }
      }
    };
  }
}

/** Cap combined evidence to a char budget (relevant slices only). */
export function capEvidence(evidence, maxChars = MAX_EVIDENCE_CHARS, maxItems = MAX_EVIDENCE_ITEMS) {
  const out = [];
  let budget = maxChars;
  for (const item of evidence || []) {
    if (out.length >= maxItems || budget <= 0) break;
    if (!item || !String(item.content || '').trim()) continue;
    const allowed = Math.min(String(item.content).length, 3000, budget);
    out.push({ ...item, content: String(item.content).slice(0, allowed) });
    budget -= allowed;
  }
  return out;
}

/**
 * Full retrieval: current-file first, then library + docs.
 * All returned evidence is permission-filtered.
 */
export async function retrieve({ query, history = [], contextPath = null, user, tree, topK = 5, includeImageBytes = false }) {
  const effectiveQuery = buildEffectiveQuery(query, history);
  const { normalized, result: contextResult, denied } = await resolveCurrentFile({
    contextPath, tree, user, query: effectiveQuery, includeImageBytes
  });

  if (contextResult) {
    const evidence = capEvidence([{
      source: 'current-file',
      title: contextResult.title,
      path: contextResult.path,
      href: contextResult.href,
      content: contextResult.snippet,
      page: null,
      metadata: contextResult.meta || {},
      attachments: contextResult.attachments || []
    }]);
    return {
      mode: 'local-content',
      contextUsed: true,
      contextDenied: false,
      normalizedContextPath: normalized,
      contextResult,
      evidence: await filterEvidenceForUser(user, evidence),
      results: [contextResult],
      source: contextResult
    };
  }

  const attempts = [];
  let evidence = [];
  for (const candidate of [effectiveQuery, query].filter((q, i, all) => q && all.indexOf(q) === i)) {
    attempts.push(candidate);
    const libraryEvidence = await searchLibrary({ query: candidate, tree, user, topK });
    const docsEvidence = libraryEvidence.length < 2
      ? await searchGuidewireDocs(candidate, 2)
      : [];
    evidence = [...libraryEvidence, ...docsEvidence]
      .sort((a, b) => (b.metadata?.score || 0) - (a.metadata?.score || 0))
      .slice(0, topK);
    if (evidence.length) break;
  }

  const capped = capEvidence(evidence);
  const filtered = await filterEvidenceForUser(user, capped);
  const toResult = ({ content, metadata, attachments, ...rest }) => ({
    ...rest,
    snippet: String(content || '').slice(0, 900)
  });
  const results = filtered.map(toResult);
  const summary = isSummaryQuery(query);

  return {
    mode: 'local-knowledge',
    contextUsed: false,
    contextDenied: denied,
    normalizedContextPath: normalized,
    contextResult: null,
    attempts,
    evidence: filtered,
    results,
    source: results[0] || null,
    summary
  };
}
