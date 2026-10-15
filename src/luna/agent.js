/**
 * Luna V2 agent — orchestration only.
 *
 * Flow: User → Luna Core (auth → retrieval → deterministic? → provider?) → answer.
 * - No provider SDK logic here (see src/luna/model.js + providers/).
 * - No raw retrieval scoring here (see src/luna/retrieval.js + tools/).
 * - No permission internals here (see src/luna/permissions.js).
 * - No history/query normalization here (see src/luna/conversation.js).
 */
import { readQueryLibrary } from '../library/local.js';
import { buildTree, allFiles } from '../library/tree.js';
import { getAllArticles, isPublicKnowledgeEnabled } from '../knowledge/data.js';
import { contentRouteForPath, canAccessLibraryPathAsync } from '../library/local.js';
import { assertLunaUser } from './permissions.js';
import {
  MAX_QUERY_LENGTH,
  MAX_HISTORY_ITEMS,
  normalizeQuery,
  sanitizeHistory,
  buildEffectiveQuery,
  needsAiReasoning,
  isSummaryQuery,
  toChatMessages
} from './conversation.js';
import { retrieve } from './retrieval.js';
import { generate, normalizeProvider, defaultModelFor, redactError, supportsVision } from './model.js';

const MAX_TOP_K = 8;
const CACHE_MS = 60_000;

let libraryCache = { expiresAt: 0, tree: null };

async function getLibraryTree() {
  if (libraryCache.tree && Date.now() < libraryCache.expiresAt) {
    return libraryCache.tree;
  }
  const { files, videos, folders, items = [] } = await readQueryLibrary();
  libraryCache = {
    tree: buildTree(files, videos, folders, items),
    expiresAt: Date.now() + CACHE_MS
  };
  return libraryCache.tree;
}

// --- Knowledge articles (public, provider-independent) ---
function articleTerms(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]*/g) || []);
}

function makeKnowledgeResults(query, topK) {
  if (!isPublicKnowledgeEnabled()) return [];
  const qTerms = [...articleTerms(query)];
  return getAllArticles()
    .map(article => {
      const searchable = [
        article.title, article.description, article.summary,
        ...(article.tags || []), ...(article.questions || [])
      ].filter(Boolean).join(' ');
      const sTerms = articleTerms(searchable);
      let hits = 0;
      for (const t of qTerms) if (sTerms.has(t)) hits += 1;
      const score = (qTerms.length ? hits / qTerms.length : 0) * 40;
      const exact = String(article.title || '').toLowerCase().includes(query.toLowerCase()) ? 30 : 0;
      return { article, score: score + exact };
    })
    .filter(row => row.score >= 8)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(row => ({
      type: 'knowledge',
      title: row.article.title || row.article.slug || 'Knowledge article',
      path: row.article.category && row.article.slug
        ? `/knowledge/${encodeURIComponent(row.article.category)}/${encodeURIComponent(row.article.slug)}`
        : '',
      href: row.article.category && row.article.slug
        ? `/knowledge/${encodeURIComponent(row.article.category)}/${encodeURIComponent(row.article.slug)}`
        : '/knowledge',
      snippet: normalizeQuery(row.article.summary || row.article.description || '').slice(0, 900),
      score: Number(row.score.toFixed(2))
    }));
}

// --- Broad library overview (deterministic, permission-filtered) ---
function isBroadSummaryQuery(query) {
  const lower = normalizeQuery(query).toLowerCase();
  return (
    /\b(?:summari[sz]e|summary|overview)\b/.test(lower) &&
    /\b(?:all|entire|whole|library|folder|folders|content|contents|everything)\b/.test(lower)
  ) || /\b(?:all|entire|whole)\s+(?:folders|library|content|contents|knowledge)\b/.test(lower);
}

async function buildLibraryOverview(tree, user) {
  const accessible = [];
  for (const file of allFiles(tree)) {
    if (!file?.path) continue;
    if (await canAccessLibraryPathAsync(user, file.path)) accessible.push(file);
  }
  const folders = new Map();
  for (const file of accessible) {
    const parts = String(file.path).split('/').filter(Boolean);
    const folderParts = parts.slice(0, -1);
    if (!folderParts.length) {
      const root = '(Root)';
      if (!folders.has(root)) folders.set(root, []);
      folders.get(root).push(file);
      continue;
    }
    for (let i = 1; i <= folderParts.length; i++) {
      const folder = folderParts.slice(0, i).join('/');
      if (!folders.has(folder)) folders.set(folder, []);
    }
    folders.get(folderParts.join('/')).push(file);
  }
  const folderRows = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, files]) => {
      const textFiles = files.filter(f => typeof f.content === 'string' && f.content.trim());
      const snippets = textFiles
        .flatMap(file => normalizeQuery(file.content).split(/(?<=[.!?])\s+|\n+/).map(normalizeQuery).filter(Boolean).slice(0, 8))
        .slice(0, 6);
      const names = files.map(f => f.name || f.path.split('/').at(-1)).filter(Boolean);
      const uniqueNames = [...new Set(names)].slice(0, 12);
      let summary;
      if (snippets.length) summary = snippets.slice(0, 3).join(' ');
      else if (uniqueNames.length) summary = 'Contains ' + uniqueNames.join(', ') + (names.length > uniqueNames.length ? ', and other library items.' : '.');
      else summary = 'No directly readable text content is available for this folder.';
      return { folder, fileCount: files.length, summary: summary.slice(0, 700), names: uniqueNames };
    });
  const lines = [
    `I found ${accessible.length} accessible library item(s) across ${folderRows.length} folder(s). This summary only includes content you are authorized to access.`,
    ''
  ];
  for (const row of folderRows) {
    lines.push(`### ${row.folder} — ${row.fileCount} item(s)`);
    lines.push(row.summary);
    lines.push('');
  }
  if (!accessible.length) {
    return { text: "I couldn't find any library content that you are authorized to access.", results: [], source: null, confidence: 'none' };
  }
  const results = accessible.slice(0, MAX_TOP_K).map(file => ({
    type: 'library',
    title: file.name || file.path.split('/').at(-1) || file.path,
    path: file.path,
    href: contentRouteForPath(file.path) + file.path.split('/').map(encodeURIComponent).join('/'),
    snippet: normalizeQuery(file.content || '').slice(0, 900)
  }));
  return { text: lines.join('\n').trim(), results, source: results[0] || null, confidence: 'medium' };
}

// --- Deterministic answer builders (unchanged semantics) ---
function chooseAnswer(query, results) {
  if (!results.length) return null;
  const best = results[0];
  const limit = isSummaryQuery(query) ? 5 : 3;
  const evidence = results.slice(0, limit)
    .map((r, i) => `${i + 1}. ${r.snippet}`)
    .filter(Boolean)
    .join('\n\n');
  const lead = isSummaryQuery(query)
    ? 'Here is a source-grounded summary from the accessible knowledge:'
    : 'Based on the accessible knowledge:';
  return {
    text: `${lead}\n\n${evidence || best.snippet}`,
    confidence: best.score >= 45 ? 'high' : best.score >= 25 ? 'medium' : 'low',
    source: best
  };
}

function buildContextAnswer(query, contextResult) {
  const meta = contextResult.meta || {};
  const text = String(contextResult.snippet || '').trim();
  if (!text || (meta.scanned && !meta.ocrSucceeded)) {
    const reason = meta.readError
      ? 'Luna could not read this file.'
      : meta.scanned
        ? 'This PDF appears to be scanned/image-based, and OCR could not extract readable text.'
        : 'No readable text was extracted from this file.';
    return {
      text: `I can see the current file, but I cannot answer from its content yet. ${reason} I will not use another library file as a substitute.`,
      confidence: 'none'
    };
  }
  if (isSummaryQuery(query)) {
    const pageBlocks = text
      .split(/(?=\[Page \d+(?: • OCR)?\])/)
      .map(block => block.trim())
      .filter(Boolean)
      .slice(0, 10);
    const excerpts = pageBlocks.map(block => block.slice(0, 700)).join('\n\n');
    return {
      text: `From the current file (${contextResult.title}):\n\n${excerpts || text.slice(0, 6000)}`,
      confidence: meta.ocrSucceeded ? 'medium' : 'high'
    };
  }
  // Reuse the document tool's windowing via retrieval evidence fallback:
  // lightweight inline match here to preserve exact legacy wording.
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const qTerms = new Set(String(query).toLowerCase().match(/[a-z_][a-z0-9_]*|\d+/g) || []);
  const qMatch = String(query).match(/\b(?:question|q)\s*#?\s*(\d+)\b/i);
  const windows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const chunk = lines.slice(i, Math.min(lines.length, i + 5)).join(' ');
    const cTerms = new Set(chunk.toLowerCase().match(/[a-z_][a-z0-9_]*|\d+/g) || []);
    let hits = 0;
    for (const t of qTerms) if (cTerms.has(t)) hits += 1;
    let score = qTerms.size ? (hits / qTerms.size) * 100 : 0;
    if (qMatch) {
      const pattern = new RegExp(`(?:^|\\b)(?:question\\s*)?${qMatch[1]}(?:[.) :\\-]|$)`, 'i');
      if (pattern.test(chunk)) score += 65;
    }
    if (score > 0) windows.push({ chunk, score });
  }
  const evidence = windows
    .sort((a, b) => b.score - a.score)
    .filter((row, index, all) => index === all.findIndex(o => o.chunk === row.chunk))
    .slice(0, 6);
  if (evidence.length) {
    return {
      text: `From the current file (${contextResult.title}):\n\n${evidence.map(row => row.chunk).join('\n\n')}`,
      confidence: meta.ocrSucceeded ? 'medium' : 'high'
    };
  }
  return {
    text: `I found the current file (${contextResult.title}), but I could not locate content that directly matches your question. I will not substitute another library file for the current file.`,
    confidence: 'low'
  };
}

/** Drop binary attachments — UI results/sources must never carry image bytes. */
function stripAttachments(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { attachments, ...rest } = obj;
  return rest;
}

function stripScores(results) {
  return (results || []).map(({ score, attachments, ...result }) => result);
}

function toProviderEvidence(retrievalEvidence, results) {
  if (retrievalEvidence && retrievalEvidence.length) {
    return retrievalEvidence.map(item => ({
      source: item.source,
      title: item.title,
      path: item.path,
      page: item.page ?? null,
      content: item.content,
      metadata: item.metadata || {},
      // Provider-neutral multimodal payload; adapters map it to their format.
      // Never logged, never persisted, never echoed in API responses.
      attachments: Array.isArray(item.attachments)
        ? item.attachments.filter(a => a && a.type === 'image' && typeof a.data === 'string').slice(0, 2)
        : []
    }));
  }
  return (results || []).slice(0, 6).map(r => ({
    source: r.type || 'library',
    title: r.title,
    path: r.path,
    page: null,
    content: r.snippet || '',
    metadata: {}
  }));
}

/**
 * Ask Luna.
 * Backwards compatible: provider/model/apiKey are optional. Without them,
 * Luna answers deterministically from retrieval (existing behavior/tests).
 * With them, explanation-seeking or low-confidence queries escalate to the
 * selected provider using only permission-filtered, capped evidence.
 */
export async function askLuna({
  query,
  history = [],
  user,
  topK = 5,
  contextPath = null,
  provider = null,
  model = null,
  apiKey = null
}) {
  const cleanQuery = normalizeQuery(query);
  if (!cleanQuery) throw new Error('Query is required.');
  if (cleanQuery.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds the maximum length of ${MAX_QUERY_LENGTH} characters.`);
  }
  assertLunaUser(user);

  const safeHistory = sanitizeHistory(history);
  const safeTopK = Math.min(Math.max(Number.parseInt(topK, 10) || 5, 1), MAX_TOP_K);
  const effectiveQuery = buildEffectiveQuery(cleanQuery, safeHistory);

  const wantsAi = Boolean(provider || model || apiKey);
  let providerId = null;
  let modelName = null;
  if (wantsAi) {
    providerId = normalizeProvider(provider || 'gemini');
    modelName = String(model || '').trim() || defaultModelFor(providerId);
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('An API key is required to use the AI provider (runtime only, never stored).');
    }
  }

  const tree = await getLibraryTree();
  // Image bytes ride along only when a vision path may consume them; local-only
  // retrieval stays text/metadata. Permission is verified before any read.
  const includeImageBytes = wantsAi && (providerId === 'openrouter' || supportsVision(providerId, modelName));
  const found = await retrieve({
    query: effectiveQuery, history: safeHistory, contextPath, user, tree, topK: safeTopK, includeImageBytes
  });

  // --- Current-file context: highest priority, never silent fallback ---
  if (found.contextResult) {
    const isImage = found.contextResult.type === 'image';
    const imageAttachments = (found.evidence || []).flatMap(e => e.attachments || []);
    // Images carry their specific honest note in the snippet (vision required /
    // too large / unsupported format), so it doubles as the deterministic answer.
    const deterministic = isImage
      ? {
          text: `From the current file (${found.contextResult.title}):\n\n${String(found.contextResult.snippet || '').trim()}`,
          confidence: 'none'
        }
      : buildContextAnswer(effectiveQuery, found.contextResult);
    // Explicit official-docs requests (e.g. comparisons) may attach public
    // Guidewire evidence alongside the current file — never as a substitute.
    let docsEvidence = [];
    if (wantsAi && /guidewire|official doc/i.test(cleanQuery)) {
      const { searchGuidewireDocs } = await import('./tools/guidewire-docs.js');
      docsEvidence = await searchGuidewireDocs(effectiveQuery, 2);
    }
    const combinedEvidence = [...found.evidence, ...docsEvidence].slice(0, 8);
    const combinedResults = [
      ...stripScores(found.results),
      ...docsEvidence.map(({ content, metadata, ...rest }) => ({
        ...rest,
        snippet: String(content || '').slice(0, 900)
      }))
    ];
    // Any question about the current image needs its pixels: escalate whenever
    // vision-ready bytes are attached, regardless of phrasing.
    const visionReady = isImage && imageAttachments.length > 0;
    const aiEligible = wantsAi && (visionReady || needsAiReasoning(cleanQuery) || deterministic.confidence === 'low' || docsEvidence.length > 0);
    if (aiEligible) {
      // Pass the deterministic answer as fallback so provider failures
      // (bad key, outage) surface a visible note instead of failing silently.
      const ai = await tryAi({ cleanQuery, safeHistory, evidence: combinedEvidence, providerId, modelName, apiKey, contextResult: found.contextResult, fallback: deterministic, results: combinedResults, source: stripAttachments(found.source) });
      if (ai) return ai;
    }
    return {
      ok: true,
      kind: 'knowledge',
      answer: deterministic.text,
      confidence: deterministic.confidence,
      results: stripScores(found.results),
      source: stripAttachments(found.source),
      agent: { mode: 'local-content', attempts: 1, recovered: false, webUsed: false, contextUsed: true, ...(wantsAi ? { aiRequested: true, aiUsed: false } : {}) }
    };
  }
  if (found.contextDenied) {
    return {
      ok: true,
      kind: 'knowledge',
      answer: 'You do not have access to the current file, so I could not verify anything from it. I will not substitute another library file.',
      confidence: 'none',
      results: [],
      source: null,
      agent: { mode: 'local-content', attempts: 1, recovered: false, webUsed: false, contextUsed: false }
    };
  }
  if (found.normalizedContextPath && /\b(?:this|the current|current|this file|the file|document|pdf|word file|image|video)\b/i.test(cleanQuery)) {
    return {
      ok: true,
      kind: 'knowledge',
      answer: 'I need the file or document context to answer that accurately. Open the file first and ask Luna from that page; I will then use that file only.',
      confidence: 'none',
      results: [],
      source: null,
      agent: { mode: 'local-content', attempts: 1, recovered: false, webUsed: false, contextUsed: false }
    };
  }

  // --- Broad overview stays deterministic (authorized content only) ---
  if (isBroadSummaryQuery(cleanQuery)) {
    const overview = await buildLibraryOverview(tree, user);
    return {
      ok: true,
      kind: 'knowledge',
      answer: overview.text,
      confidence: overview.confidence,
      results: overview.results,
      source: overview.source,
      agent: { mode: 'local-knowledge', attempts: 1, recovered: false, webUsed: false, contextUsed: false }
    };
  }

  // --- Merge retrieval evidence with public knowledge articles ---
  const knowledgeRows = makeKnowledgeResults(effectiveQuery, safeTopK);
  const knowledgeEvidence = knowledgeRows.map(r => ({
    source: 'knowledge',
    title: r.title,
    path: r.path,
    href: r.href,
    content: r.snippet,
    page: null,
    metadata: { score: r.score }
  }));
  const merged = [...found.evidence, ...knowledgeEvidence]
    .sort((a, b) => (b.metadata?.score || 0) - (a.metadata?.score || 0))
    .slice(0, safeTopK);
  const mergedResults = merged.map(({ content, metadata, attachments, ...rest }) => ({
    ...rest,
    snippet: String(content || '').slice(0, 900)
  }));
  const scoredForConfidence = mergedResults.map((r, i) => ({
    ...r,
    score: merged[i]?.metadata?.score ?? 20
  }));
  const deterministic = chooseAnswer(cleanQuery, scoredForConfidence.length ? scoredForConfidence : []);

  const aiEligible = wantsAi && (!deterministic || deterministic.confidence === 'low' || deterministic.confidence === 'none' || needsAiReasoning(cleanQuery));
  if (aiEligible) {
    const ai = await tryAi({ cleanQuery, safeHistory, evidence: merged, providerId, modelName, apiKey, contextResult: null, fallback: deterministic, results: mergedResults, source: mergedResults[0] || null });
    if (ai) return ai;
  }

  return {
    ok: true,
    kind: 'knowledge',
    answer: deterministic?.text || "I couldn't find a confident answer in the Guidewire Website knowledge sources.",
    confidence: deterministic?.confidence || 'none',
    results: mergedResults,
    source: deterministic?.source ? mergedResults[0] || null : null,
    agent: {
      mode: 'local-knowledge',
      attempts: found.attempts?.length || 1,
      recovered: (found.attempts?.length || 1) > 1,
      webUsed: false,
      contextUsed: false,
      ...(wantsAi ? { aiRequested: true, aiUsed: false } : {})
    }
  };
}

async function tryAi({ cleanQuery, safeHistory, evidence, providerId, modelName, apiKey, contextResult, fallback = null, results = null, source = null }) {
  const providerEvidence = toProviderEvidence(evidence, results);
  if (!providerEvidence.length) return null;
  const messages = toChatMessages({ query: cleanQuery, history: safeHistory });
  try {
    const out = await generate({ provider: providerId, model: modelName, apiKey, messages, evidence: providerEvidence });
    const finalResults = results ?? (contextResult ? stripScores([contextResult]) : []);
    const finalSource = stripAttachments(source ?? contextResult ?? null);
    return {
      ok: true,
      kind: 'knowledge',
      answer: out.text,
      confidence: 'medium',
      results: finalResults,
      source: finalSource,
      agent: {
        mode: 'ai-assisted',
        attempts: 1,
        recovered: false,
        webUsed: false,
        contextUsed: Boolean(contextResult),
        aiRequested: true,
        aiUsed: true,
        provider: providerId
      }
    };
  } catch (error) {
    // Fall back to deterministic; never expose the key or raw provider text.
    const safe = redactError(error?.message || 'AI provider request failed.');
    if (fallback) {
      return {
        ok: true,
        kind: 'knowledge',
        answer: `${fallback.text}\n\n(Note: AI assistance was unavailable: ${safe})`,
        confidence: fallback.confidence,
        results: results ?? [],
        source: stripAttachments(results?.[0] || source || null),
        agent: {
          mode: contextResult ? 'local-content' : 'local-knowledge',
          attempts: 1, recovered: true, webUsed: false,
          contextUsed: Boolean(contextResult),
          aiRequested: true, aiUsed: false, provider: providerId, aiError: safe
        }
      };
    }
    return null;
  }
}

/** Validate a runtime API key with a minimal provider request (Test Connection). */
export async function validateLunaConnection({ provider, model, apiKey }) {
  const { validateApiKey } = await import('./model.js');
  return validateApiKey({ provider: provider || 'gemini', model, apiKey });
}

export { getLibraryTree };

/** Test/dev hook: drop the cached library tree so newly added fixtures resolve. */
export function clearLunaLibraryCache() {
  libraryCache = { expiresAt: 0, tree: null };
}
