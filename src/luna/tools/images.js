/**
 * Image tool: identify image assets, and — only after the caller has
 * authorized the path — read actual bytes for vision-capable providers.
 * Evidence uses a provider-neutral shape:
 *   { source, title, path, href, content, page, metadata,
 *     attachments: [{ type:'image', mimeType, bytes, data }] }
 * `data` is base64 and is only populated when `includeBytes` is true.
 * Nothing here is ever logged; adapters map attachments to their own format.
 */
import { readFile, stat } from 'node:fs/promises';
import { contentRouteForPath, resolveLibraryPath } from '../../library/local.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

/** MIME types accepted inline by vision providers (matches official inline limits). */
export const VISION_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Per-file inline payload cap (official Gemini inline limit is 7 MB). */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

export function isImagePath(relPath) {
  const ext = String(relPath || '').toLowerCase().slice(String(relPath || '').lastIndexOf('.'));
  return IMAGE_EXTS.has(ext);
}

export function mimeTypeForImage(relPath) {
  const ext = String(relPath || '').toLowerCase().slice(String(relPath || '').lastIndexOf('.'));
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function hrefFor(relPath) {
  return contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');
}

export function describeImage({ relPath, bytes = null }) {
  const title = String(relPath).split('/').at(-1) || relPath;
  const href = contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');
  return [{
    source: 'image',
    title,
    path: relPath,
    href,
    content: `Image file: ${title}. Visual question answering requires a vision model; Luna Core can identify this asset but cannot interpret its pixels.`,
    page: null,
    metadata: { type: 'image', bytes: bytes ?? null, visionAvailable: false }
  }];
}

/**
 * Read an authorized image path. Call ONLY after permission checks pass.
 * @param {object} opts
 * @param {string} opts.relPath library-relative path
 * @param {boolean} [opts.includeBytes] attach base64 for a vision provider
 * @returns {Promise<{ evidence:Array, readable:boolean, error?:string }>}
 */
export async function readImageEvidence({ relPath, includeBytes = false }) {
  const title = String(relPath).split('/').at(-1) || relPath;
  const mimeType = mimeTypeForImage(relPath);
  const absPath = resolveLibraryPath(relPath);
  if (!absPath) {
    return { evidence: describeImage({ relPath }), readable: false, error: 'invalid-path' };
  }

  let size = null;
  try {
    size = (await stat(absPath)).size;
  } catch {
    return { evidence: describeImage({ relPath }), readable: false, error: 'unreadable' };
  }

  if (!VISION_MIME_TYPES.has(mimeType)) {
    return {
      readable: false,
      error: 'unsupported-format',
      evidence: [{
        source: 'image',
        title,
        path: relPath,
        href: hrefFor(relPath),
        content: `Image file: ${title} (${mimeType}). This format cannot be sent to a vision model; supported formats are JPEG, PNG, and WebP.`,
        page: null,
        metadata: { type: 'image', mimeType, bytes: size, visionAvailable: false }
      }]
    };
  }

  if (!includeBytes) return { evidence: describeImage({ relPath, bytes: size }), readable: true };

  if (size > MAX_IMAGE_BYTES) {
    return {
      readable: false,
      error: 'too-large',
      evidence: [{
        source: 'image',
        title,
        path: relPath,
        href: hrefFor(relPath),
        content: `Image file: ${title} is too large to send to the AI provider (limit ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB).`,
        page: null,
        metadata: { type: 'image', mimeType, bytes: size, visionAvailable: false }
      }]
    };
  }

  const data = (await readFile(absPath)).toString('base64');
  return {
    readable: true,
    evidence: [{
      source: 'image',
      title,
      path: relPath,
      href: hrefFor(relPath),
      content: `Image: ${title} (${mimeType}, ${size} bytes) attached from the current file for visual understanding.`,
      page: null,
      metadata: { type: 'image', mimeType, bytes: size, visionAvailable: true },
      attachments: [{ type: 'image', mimeType, bytes: size, data }]
    }]
  };
}
