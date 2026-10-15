/**
 * OpenRouter provider adapter (future-ready, minimal).
 * OpenAI-compatible chat-completions endpoint. Only used when the user
 * explicitly selects the openrouter provider with their own runtime key.
 *
 * Docs: https://openrouter.ai/docs
 */

const GENERATE_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 15_000;

export const MAX_EVIDENCE_CHARS = 12_000;
export const MAX_ITEM_CHARS = 3_000;

function evidencePrompt(evidence) {
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
    const block = `${header}\n${content}`;
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

function toMessages(messages, evidence) {
  const ev = evidencePrompt(evidence);
  const images = imageAttachmentsOf(evidence);
  const system = images.length
    ? `You are Luna, a source-grounded assistant for a private Guidewire learning library. An image from the user's current file is attached to their question: treat it as the primary evidence. Read its text, tables, checkboxes, highlights, layout, and visual context directly. Quote or cite what you see. If the image does not contain the answer, say it could not be verified.\n\nEVIDENCE:\n${ev}`
    : ev
      ? `You are Luna, a source-grounded assistant for a private Guidewire learning library. Answer ONLY from the evidence below. Cite source titles/paths where possible. If the evidence does not contain the answer, say it could not be verified.\n\nEVIDENCE:\n${ev}`
      : 'You are Luna, a source-grounded assistant. If you lack evidence, say the answer could not be verified.';
  const out = [{ role: 'system', content: system }];
  const turns = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    turns.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 8000)
    });
  }
  // OpenAI-compatible multimodal format: image parts ride on the latest user
  // turn as data URLs. Key stays in the Authorization header only.
  if (images.length && turns.length) {
    const lastUser = [...turns].reverse().find(t => t.role === 'user') || turns[turns.length - 1];
    lastUser.content = [
      { type: 'text', text: lastUser.content },
      ...images.map(image => ({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` }
      }))
    ];
  }
  out.push(...turns);
  return out;
}

function classifyError(status, bodyText) {
  const text = String(bodyText || '');
  if (status === 401 || status === 403) return new Error('Invalid OpenRouter API key.');
  // Never pretend: surface incapable models as a clear, static, safe message.
  if (/image|vision|multimodal|unsupported.*modality|modality/i.test(text)) {
    return new Error('This OpenRouter model does not appear to support image input. Choose a vision-capable model.');
  }
  return new Error(`OpenRouter request failed (status ${status}).`);
}

export async function generate({ messages, evidence = [], model, apiKey, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-title': 'Luna V2'
      },
      body: JSON.stringify({
        model: String(model || 'openrouter/auto').trim(),
        messages: toMessages(messages, evidence),
        temperature: 0.2,
        max_tokens: 1024
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyError(response.status, body);
    }
    const data = await response.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('OpenRouter returned an empty response.');
    return { text, model: String(model || 'openrouter/auto'), provider: 'openrouter', usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

export async function validate({ model, apiKey, fetchImpl = fetch }) {
  const result = await generate({
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    evidence: [],
    model,
    apiKey,
    fetchImpl
  });
  void result;
  return { ok: true, provider: 'openrouter', model: String(model || 'openrouter/auto') };
}
