import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

const VIDEO_MIME_MAP = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
};

export function isVideoFileName(value) {
  return typeof value === 'string' && VIDEO_EXTENSIONS.has(path.extname(value).toLowerCase());
}

export function videoMimeType(filename) {
  return VIDEO_MIME_MAP[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

// Parse a single HTTP Range header for a file of `size` bytes.
// Returns { start, end } for a satisfiable range, or null when the range is
// malformed/unsatisfiable (the caller should answer 416 in that case).
export function parseRange(rangeHeader, size) {
  const input = typeof rangeHeader === 'string' ? rangeHeader.trim() : '';
  if (!/^bytes=\d*-\d*$/.test(input)) return null;
  const [, rawStart, rawEnd] = /^bytes=(\d*)-(\d*)$/.exec(input);
  let start;
  let end;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isInteger(start) || start < 0 || start >= size) return null;
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isInteger(end)) return null;
    if (end >= size) end = size - 1;
    if (end < start) return null;
  }

  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

function pipeFile(res, filePath, opts) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, opts);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        res.end?.();
      } catch {
        // The response may already be gone; nothing else to do.
      }
      resolve();
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };

    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', fail);
    // If the client disconnects, stop reading instead of crashing.
    if (res && typeof res.on === 'function') {
      res.on('close', () => stream.destroy());
    }
    // Manual pump (no stream.pipe) so a minimal/backpressured destination works.
    stream.on('data', chunk => {
      const ok = res.write(chunk);
      if (ok === false && typeof res.once === 'function') {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
  });
}

// Stream a validated file to the response, honoring HTTP Range so browsers can
// seek. Never buffers the whole file; the video is streamed in chunks.
// Resolves with 'full' | 'partial' | 'unsatisfied' (416 already answered).
export async function streamVideoFile(res, filePath, rangeHeader) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    const error = new Error('Not a file.');
    error.code = 'ENOENT';
    throw error;
  }

  const mime = videoMimeType(filePath);
  const size = fileStat.size;
  const rangesEnabled = typeof rangeHeader === 'string' && rangeHeader.trim().startsWith('bytes=');

  if (!rangesEnabled) {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    await pipeFile(res, filePath);
    return 'full';
  }

  const range = parseRange(rangeHeader, size);
  if (!range) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    res.end();
    return 'unsatisfied';
  }

  if (range.start === 0 && range.end === size - 1) {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    await pipeFile(res, filePath);
    return 'full';
  }

  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': range.end - range.start + 1,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Accept-Ranges': 'bytes'
  });
  await pipeFile(res, filePath, { start: range.start, end: range.end });
  return 'partial';
}