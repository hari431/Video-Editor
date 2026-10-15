/**
 * Document tool: read only the relevant sections of a document.
 * Never returns the whole large document — callers get capped windows.
 */
import { readLibraryContent } from '../content-reader.js';
import { contentRouteForPath } from '../../library/local.js';
import { extractQuestionNumber } from '../conversation.js';

const STOPWORDS = new Set([
  'a','an','the','is','are','what','which','who','where','when','why','how',
  'do','does','did','can','could','would','should','will','may','might',
  'i','you','this','that','these','those','to','of','for','from','in','on','at','by','with','about','and','or'
]);

function terms(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z_][a-z0-9_]*|\d+/g) || []);
}

function meaningful(text) {
  return [...terms(text)].filter(t => !STOPWORDS.has(t) && t.length > 1);
}

function overlap(queryTerms, textTerms) {
  if (!queryTerms.length || !textTerms.size) return 0;
  let hits = 0;
  for (const t of queryTerms) if (textTerms.has(t)) hits += 1;
  return hits / queryTerms.length;
}

export function relevantWindows(query, text, maxWindows = 6, windowLines = 5) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const queryTerms = meaningful(query);
  const questionNumber = extractQuestionNumber(query);
  const windows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const chunk = lines.slice(i, Math.min(lines.length, i + windowLines)).join(' ');
    let score = overlap(queryTerms, terms(chunk)) * 100;
    if (questionNumber != null) {
      const pattern = new RegExp(`(?:^|\\b)(?:question\\s*)?${questionNumber}(?:[.) :\\-]|$)`, 'i');
      if (pattern.test(chunk)) score += 65;
    }
    if (score > 0) windows.push({ chunk: chunk.slice(0, 1500), score });
  }
  return windows
    .sort((a, b) => b.score - a.score)
    .filter((row, index, all) => index === all.findIndex(o => o.chunk === row.chunk))
    .slice(0, maxWindows);
}

/**
 * Read a document and return capped, query-relevant evidence items.
 * @returns {Promise<{evidence:Array, meta:object, readable:boolean, error?:string}>}
 */
export async function readDocumentSections({ relPath, node = null, query = '', maxChars = 6000 }) {
  const readable = await readLibraryContent(relPath, node);
  const text = String(readable.text || '').trim();
  const meta = readable.meta || {};
  if (!text || (meta.scanned && !meta.ocrSucceeded)) {
    return { evidence: [], meta, readable: false, error: meta.readError || 'unreadable' };
  }
  const title = String(relPath).split('/').at(-1) || relPath;
  const href = contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');

  // Summary queries: first page blocks. Others: relevant windows.
  const isSummary = /\b(?:summari[sz]e|summary|overview|gist)\b/i.test(String(query));
  let items;
  if (isSummary) {
    const blocks = text
      .split(/(?=\[Page \d+(?: • OCR)?\])/)
      .map(b => b.trim())
      .filter(Boolean)
      .slice(0, 4);
    const content = (blocks.length ? blocks.join('\n\n') : text).slice(0, maxChars);
    items = [{ source: 'library', title, path: relPath, href, content, page: null, metadata: meta }];
  } else {
    const windows = relevantWindows(query, text);
    const picked = windows.length
      ? windows
      : [{ chunk: text.slice(0, 1500), score: 0 }];
    let budget = maxChars;
    items = [];
    for (const w of picked) {
      if (budget <= 0) break;
      const slice = w.chunk.slice(0, Math.min(w.chunk.length, budget));
      const pageMatch = slice.match(/\[Page (\d+)/);
      items.push({
        source: 'library',
        title,
        path: relPath,
        href,
        content: slice,
        page: pageMatch ? Number(pageMatch[1]) : null,
        metadata: meta
      });
      budget -= slice.length;
    }
  }
  return { evidence: items, meta, readable: true };
}
