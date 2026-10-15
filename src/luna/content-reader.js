import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { resolveLibraryPath, extractYouTubeId } from '../library/local.js';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_OCR_PAGES = 30;
const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const PDF_OCR_SCALE = 1.5;
const MAX_EXTRACTED_CHARS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;

let pdfjsPromise = null;
let ocrWorkerPromise = null;

function extension(relPath) {
  return path.extname(String(relPath || '')).toLowerCase();
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng', 1, {
        logger: () => {}
      });
    })().catch(error => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function renderPdfPagePng(page) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const baseViewport = page.getViewport({ scale: 1 });
  const scaleByArea = Math.sqrt(MAX_PDF_IMAGE_PIXELS / Math.max(1, baseViewport.width * baseViewport.height));
  const scale = Math.min(PDF_OCR_SCALE, Math.max(0.5, scaleByArea));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');

  const renderTask = page.render({
    canvasContext: context,
    viewport
  });
  await renderTask.promise;

  const png = await canvas.encode('png');
  return Buffer.from(png);
}

async function ocrPdfPage(page) {
  const worker = await getOcrWorker();
  const png = await renderPdfPagePng(page);
  const result = await worker.recognize(png);
  return normalize(result?.data?.text || '');
}

async function extractPdf(absPath) {
  const bytes = await readFile(absPath);
  const textHeader = new TextDecoder('utf-8').decode(bytes.slice(0, 100));
  if (textHeader.startsWith('version https://git-lfs.github.com')) {
    throw new Error('This file is a Git LFS pointer. The actual large PDF asset has not been pulled in this environment.');
  }

  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS
  }).promise;

  const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages = [];
  const ocrCandidates = [];

  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const text = await page.getTextContent();
    const pageText = normalize(text.items.map(item => item?.str || '').join(' '));

    if (pageText.length >= 40) {
      pages.push({ pageNo, text: pageText, source: 'text' });
    } else {
      ocrCandidates.push({ pageNo, page });
    }
  }

  let ocrAttempted = 0;
  let ocrSucceeded = 0;
  let ocrError = null;

  if (ocrCandidates.length) {
    const candidates = ocrCandidates.slice(0, MAX_OCR_PAGES);
    ocrAttempted = candidates.length;

    try {
      for (const candidate of candidates) {
        try {
          const ocrText = await ocrPdfPage(candidate.page);
          if (ocrText) {
            pages.push({ pageNo: candidate.pageNo, text: ocrText, source: 'ocr' });
            ocrSucceeded += 1;
          }
        } catch (error) {
          ocrError = error;
          break;
        }
      }
    } catch (error) {
      ocrError = error;
    }
  }

  pages.sort((a, b) => a.pageNo - b.pageNo);

  const renderedPages = pages.map(page =>
    `[Page ${page.pageNo}${page.source === 'ocr' ? ' • OCR' : ''}] ${page.text}`
  );

  const suffixes = [];
  if (doc.numPages > MAX_PDF_PAGES) {
    suffixes.push(`Only the first ${MAX_PDF_PAGES} pages were read.`);
  }
  if (ocrCandidates.length > MAX_OCR_PAGES) {
    suffixes.push(`OCR was attempted on the first ${MAX_OCR_PAGES} image-only pages.`);
  }
  if (ocrError) {
    suffixes.push('OCR could not complete for every scanned page.');
  }

  return {
    text: (renderedPages.join('\n') + (suffixes.length ? `\n[${suffixes.join(' ')}]` : '')).slice(0, MAX_EXTRACTED_CHARS),
    meta: {
      type: 'pdf',
      pages: doc.numPages,
      extractedPages: pageCount,
      scanned: ocrCandidates.length > 0,
      ocrAttempted,
      ocrSucceeded,
      ocrAvailable: ocrSucceeded > 0,
      ocrComplete: ocrCandidates.length === 0 || ocrSucceeded === ocrCandidates.length
    }
  };
}

async function extractDocx(absPath) {
  const result = await mammoth.extractRawText({ path: absPath });
  return {
    text: normalize(result.value).slice(0, MAX_EXTRACTED_CHARS),
    meta: {
      type: 'docx',
      warnings: Array.isArray(result.messages) ? result.messages.map(m => m.message).slice(0, 10) : []
    }
  };
}

async function fetchYouTubeTranscript(videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
        'origin': 'https://www.youtube.com'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38'
          }
        },
        videoId
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`YouTube player request failed (${response.status}).`);
    const player = await response.json();
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      return { text: '', meta: { type: 'youtube', videoId, transcriptAvailable: false } };
    }

    const preferred =
      tracks.find(t => String(t.languageCode || '').toLowerCase().startsWith('en')) ||
      tracks.find(t => String(t.kind || '').toLowerCase() === 'asr') ||
      tracks[0];

    const baseUrl = preferred?.baseUrl;
    if (!baseUrl) return { text: '', meta: { type: 'youtube', videoId, transcriptAvailable: false } };

    const transcriptController = new AbortController();
    const transcriptTimer = setTimeout(() => transcriptController.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('fmt', 'json3');

      const transcriptResponse = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: transcriptController.signal
      });

      if (!transcriptResponse.ok) {
        return { text: '', meta: { type: 'youtube', videoId, transcriptAvailable: false } };
      }

      const body = await transcriptResponse.text();
      if (!body.trim()) {
        return { text: '', meta: { type: 'youtube', videoId, transcriptAvailable: false } };
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return { text: '', meta: { type: 'youtube', videoId, transcriptAvailable: false } };
      }

      const segments = [];
      for (const event of data?.events || []) {
        const text = normalize((event.segs || []).map(seg => seg?.utf8 || '').join(' '));
        if (!text) continue;
        segments.push({
          startMs: Number(event.tStartMs || 0),
          durationMs: Number(event.dDurationMs || 0),
          text
        });
      }

      const text = segments
        .map(segment => `[${formatTimestamp(segment.startMs)}] ${segment.text}`)
        .join('\n')
        .slice(0, MAX_EXTRACTED_CHARS);

      return {
        text,
        meta: {
          type: 'youtube',
          videoId,
          transcriptAvailable: Boolean(text),
          languageCode: preferred.languageCode || null,
          generated: String(preferred.kind || '').toLowerCase() === 'asr',
          segments: segments.length
        }
      };
    } finally {
      clearTimeout(transcriptTimer);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function readLibraryContent(relPath, node = null) {
  const safePath = String(relPath || '');
  const absPath = resolveLibraryPath(safePath);
  if (!absPath) throw new Error('Invalid library path.');

  const ext = extension(safePath);
  const name = path.basename(safePath);

  if (node?.type === 'external' || /^external - /i.test(name)) {
    const raw = String(node?.file?.content || node?.content || '');
    const urlMatch = raw.match(/https?:\/\/\S+/i);
    const externalUrl = node?.file?.externalUrl || (urlMatch ? urlMatch[0].replace(/[)>.,]+$/, '') : '');
    const videoId = extractYouTubeId(externalUrl || '');
    if (videoId) {
      const transcript = await fetchYouTubeTranscript(videoId);
      return {
        text: transcript.text || `YouTube video ${videoId} does not currently expose a readable transcript to Luna.`,
        meta: { ...transcript.meta, externalUrl }
      };
    }
    return {
      text: `External resource: ${externalUrl || raw}`,
      meta: { type: 'external', externalUrl: externalUrl || null }
    };
  }

  if (node?.type === 'video' || ['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) {
    const stats = await stat(absPath);
    return {
      text: 'This is a local video file. Luna can identify the file, but a transcript/visual model is required to understand its audio and frames.',
      meta: { type: 'video', bytes: stats.size, transcriptAvailable: false }
    };
  }

  if (['.txt', '.md', '.csv', '.json', '.xml', '.gosu', '.gs', '.pcf', '.eti'].includes(ext)) {
    const stats = await stat(absPath);
    if (stats.size > MAX_TEXT_BYTES) {
      throw new Error(`This text file is too large to read directly (limit ${MAX_TEXT_BYTES} bytes).`);
    }
    const text = node?.content != null ? String(node.content) : await readFile(absPath, 'utf8');
    return { text: text.slice(0, MAX_EXTRACTED_CHARS), meta: { type: 'text', extension: ext } };
  }

  if (ext === '.docx') return extractDocx(absPath);
  if (ext === '.pdf') return extractPdf(absPath);

  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
    const stats = await stat(absPath);
    return {
      text: `Image file: ${name}. Luna can identify this asset, but visual question answering/OCR requires a vision model.`,
      meta: { type: 'image', bytes: stats.size, visionAvailable: false }
    };
  }

  const stats = await stat(absPath);
  return {
    text: `File: ${name} (${ext || 'unknown'}), ${stats.size} bytes. A format-specific reader is not currently available.`,
    meta: { type: 'binary', extension: ext, bytes: stats.size }
  };
}

export { formatTimestamp };
