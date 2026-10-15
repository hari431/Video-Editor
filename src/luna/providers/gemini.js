/**
 * Gemini provider adapter.
 * ONLY file in Luna that may know Gemini REST shapes.
 * Uses the current official Generative Language REST API with API-key auth
 * via the `x-goog-api-key` header (no SDK dependency, no key in URL).
 *
 * Docs: https://ai.google.dev/gemini-api/docs
 */

const GENERATE_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 15_000;

/** Max evidence chars sent to Gemini — relevant slices only, never whole dumps. */
export const MAX_EVIDENCE_CHARS = 12_000;
export const MAX_ITEM_CHARS = 3_000;

function evidenceBlock(evidence) {
  const items = (evidence || []).slice(0, 8);
  let budget = MAX_EVIDENCE_CHARS;
  const blocks = [];
  for (const item of items) {
    if (budget <= 0) break;
    const content = String(item?.content || '').slice(0, MAX_ITEM_CHARS);
    if (!content.trim()) continue;
    const header = [
      `Source: ${item.source || 'library'}`,
      item.title ? `Title: ${item.title}` : null,
      item.path ? `Path: ${item.path}` : null,
      item.page ? `Page: ${item.page}` : null
    ]
      .filter(Boolean)
      .join(' | ');
    const block = `${header}\n${content}`.slice(0, Math.min(content.length + 200, budget));
    blocks.push(block);
    budget -= block.length;
  }
  return blocks.join('\n\n---\n\n');
}

function imageAttachmentsOf(evidence, limit = 2) {
  const out = [];
  for (const item of evidence || []) {
    for (const attachment of item?.attachments || []) {
      if (attachment && attachment.type === 'image' && typeof attachment.data === 'string' && attachment.data) {
        out.push({ mimeType: String(attachment.mimeType || 'image/jpeg'), data: attachment.data });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function toGeminiContents(messages, evidence) {
  const ev = evidenceBlock(evidence);
  const images = imageAttachmentsOf(evidence);
  const systemInstruction = images.length
    ? `You are Luna, a source-grounded assistant for a private Guidewire learning library. An image from the user's current file is attached to their question: treat it as the primary evidence. Read its text, tables, checkboxes, highlights, layout, and visual context directly. Quote or cite what you see. If the image does not contain the answer, say it could not be verified.\n\nEVIDENCE:\n${ev}`
    : ev
      ? `You are Luna, a source-grounded assistant for a private Guidewire learning library. Answer ONLY from the evidence below. Quote or cite source titles/paths where possible. If the evidence does not contain the answer, say it could not be verified.\n\nEVIDENCE:\n${ev}`
      : 'You are Luna, a source-grounded assistant. If you lack evidence, say the answer could not be verified.';

  const history = (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, 8000) }]
    }));

  const contents = history.length ? history : [{ role: 'user', parts: [{ text: 'Hello' }] }];

  // Official multimodal format: image bytes travel as inlineData parts on the
  // user's turn — never as text, never in logs, key stays in the header only.
  if (images.length) {
    const lastUser = [...contents].reverse().find(c => c.role === 'user') || contents[contents.length - 1];
    for (const image of images) {
      lastUser.parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
  }

  return {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents
  };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .map(p => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function classifyError(status, bodyText) {
  const text = String(bodyText || '');
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(text)) {
    return new Error('Invalid Gemini API key.');
  }
  if (status === 401 || status === 403) return new Error('Invalid Gemini API key.');
  if (status === 404) return new Error('Unknown Gemini model. Check the model name.');
  if (status === 429) return new Error('Gemini rate limit reached. Try again shortly.');
  return new Error(`Gemini request failed (status ${status}).`);
}

export async function generate({ messages, evidence = [], model, apiKey, fetchImpl = fetch }) {
  const modelName = encodeURIComponent(String(model || 'gemini-2.5-flash').trim());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          ...toGeminiContents(messages, evidence),
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
        }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyError(response.status, body);
    }
    const data = await response.json();
    const text = extractText(data);
    if (!text) throw new Error('Gemini returned an empty response.');
    return { text, model: String(model || 'gemini-2.5-flash'), provider: 'gemini', usage: data?.usageMetadata || null };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal validation: tiny generateContent call. Never logs the key. */
export async function validate({ model, apiKey, fetchImpl = fetch }) {
  const modelName = encodeURIComponent(String(model || 'gemini-2.5-flash').trim());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8 }
        }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyError(response.status, body);
    }
    return { ok: true, provider: 'gemini', model: String(model || 'gemini-2.5-flash') };
  } finally {
    clearTimeout(timer);
  }
}

