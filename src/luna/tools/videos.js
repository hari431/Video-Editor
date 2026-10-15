/**
 * Video tool: local video placeholders + YouTube transcript evidence.
 * Reuses content-reader (YouTube transcripts, local video metadata).
 */
import { readLibraryContent } from '../content-reader.js';
import { contentRouteForPath } from '../../library/local.js';

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

export function isVideoPath(relPath, node = null) {
  if (node?.type === 'video') return true;
  const dot = String(relPath || '').lastIndexOf('.');
  return VIDEO_EXTS.has(String(relPath || '').toLowerCase().slice(dot));
}

function sliceTranscript(text, query, maxChars = 4000) {
  const q = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!q.length) return lines.slice(0, 40).join('\n').slice(0, maxChars);
  const scored = lines.map(line => ({
    line,
    score: q.filter(term => line.toLowerCase().includes(term)).length
  }));
  const hits = scored.filter(s => s.score > 0).slice(0, 20);
  const picked = hits.length ? hits : scored.slice(0, 20);
  return picked.map(s => s.line).join('\n').slice(0, maxChars);
}

export async function readVideoEvidence({ relPath, node = null, query = '' }) {
  const readable = await readLibraryContent(relPath, node);
  const meta = readable.meta || {};
  const title = String(relPath).split('/').at(-1) || relPath;
  const href = contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');

  if (meta.type === 'youtube' && meta.transcriptAvailable && readable.text) {
    return {
      readable: true,
      evidence: [{
        source: 'video-transcript',
        title,
        path: relPath,
        href,
        content: `YouTube transcript excerpts:\n${sliceTranscript(readable.text, query)}`,
        page: null,
        metadata: meta
      }]
    };
  }

  return {
    readable: false,
    evidence: [{
      source: 'video',
      title,
      path: relPath,
      href,
      content: `Video file: ${title}. ${readable.text || 'A transcript/visual model is required to understand its audio and frames.'}`,
      page: null,
      metadata: meta
    }]
  };
}
