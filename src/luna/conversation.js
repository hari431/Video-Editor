/**
 * Luna V2 conversation / context handling.
 * Provider-independent: query normalization, history sanitation,
 * current-file reference detection. No AI calls here.
 */

export const MAX_QUERY_LENGTH = 4000;
export const MAX_HISTORY_ITEMS = 20;

/** Heuristic: does the query refer to the currently open file? */
const CURRENT_FILE_PATTERN =
  /\b(?:this|current|the current|this file|the file|this pdf|this document|this doc|the answer|why\b|question\s*#?\s*\d+)\b/i;

const EXPLICIT_CURRENT_FILE_PATTERN =
  /\b(?:this|current)\b|\bthis\s+(?:file|pdf|doc|document|video|image)\b|\bquestion\s*#?\s*\d+\b/i;

export function normalizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim();
}

export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_ITEMS)
    .filter(m => m && typeof m.content === 'string')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, 2000)
    }))
    .filter(m => m.content.trim());
}

/** Expand deictic follow-ups ("that", "why", ...) with previous turns. */
export function buildEffectiveQuery(query, history) {
  const text = normalizeQuery(query);
  const lower = text.toLowerCase();
  const deictic = /\b(?:that|this|it|those|these|above|previous|earlier|again|same|there|why|how)\b/.test(lower);
  if (!deictic || !Array.isArray(history) || !history.length) return text;

  const previousUsers = history
    .filter(m => String(m?.role || '').toLowerCase() === 'user')
    .map(m => String(m?.content || '').trim())
    .filter(Boolean);
  const previousAssistant = history
    .filter(m => String(m?.role || '').toLowerCase() === 'assistant')
    .map(m => String(m?.content || '').trim())
    .filter(Boolean);

  return [text, previousUsers.at(-1), previousAssistant.at(-1)?.slice(0, 700)]
    .filter(Boolean)
    .join(' ');
}

/** True when the query probably needs the current-file context first. */
export function referencesCurrentFile(query) {
  return CURRENT_FILE_PATTERN.test(String(query || ''));
}

/** True for explicit current-file references ("this file", "question 4", ...). */
export function explicitlyReferencesCurrentFile(query) {
  return EXPLICIT_CURRENT_FILE_PATTERN.test(String(query || ''));
}

export function extractQuestionNumber(query) {
  const match = String(query || '').match(/\b(?:question|q)\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

/** True when the query asks for explanation/reasoning → escalate to AI when available. */
export function needsAiReasoning(query) {
  return /\b(?:why|explain|reason|how come|correct\W*(?:answer|option)|which option|elaborate|summar[iy]ze in (?:your|own)|compare|analyze|analyse)\b/i.test(
    String(query || '')
  );
}

export function isSummaryQuery(query) {
  return /\b(?:summari[sz]e|summary|overview|give me the gist|what is this about)\b/i.test(
    String(query || '')
  );
}

/** Convert internal history to provider-neutral chat messages. */
export function toChatMessages({ query, history = [], system = null }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  for (const turn of sanitizeHistory(history)) messages.push(turn);
  messages.push({ role: 'user', content: normalizeQuery(query) });
  return messages;
}
