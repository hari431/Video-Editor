// src/video/routes.js — HTTP surface for the standalone BrowserVideoStudio.
// Ported from the original src/server.js editor/recorder/EDL routes minus
// library, admin roles, AI video and Thiings. Every handler here is
// local-only: it operates on bytes uploaded by the client and streams a fresh
// download back. Nothing reads or writes shared storage.
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createReadStream } from 'node:fs';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import {
  isVideoEditorAvailable,
  editorMaxVideoMb,
  editorMaxVideoBytes,
  editorMaxRequestBytes,
  EDITOR_MAX_VIDEO_FILES,
  EDITOR_MAX_AUDIO_FILES,
  EDITOR_MAX_IMAGE_FILES,
  EDITOR_MAX_AUDIO_BYTES,
  EDITOR_MAX_IMAGE_BYTES,
  EDITOR_MAX_SPEC_BYTES,
  EDITOR_FFMPEG_TIMEOUT_MS,
  isAllowedEditorInput,
  isAllowedEditorAudio,
  isAllowedEditorImage,
  getMultipartBoundary,
  parseMultipartForm,
  validateEditSpec,
  validateSpecV2,
  normalizeExportResolution,
  buildFfmpegArgs,
  buildScreenRecordingFfmpegArgs
} from '../library/video-editor.js';
import {
  checkEdlEvidence,
  validateEdlStructure,
  allowlistedEdlSource,
  edlToSpecV2,
  edlCutSummary
} from '../library/edl-evidence.js';
import {
  probeMediaFile,
  findLocalEditorFont,
  exportProgress,
  runLocalFfmpeg,
  activeExports,
  handleEditorExportV2
} from './ffmpeg.js';

// Local-only EDL evidence verdict. Never renders; validates structure,
// source allowlisting and (when present) evidence alignment.
export function validateEdlEvidenceRequest(body) {
  const fail = (errors, summary = null) => ({ ok: false, status: 'FAILED', errors, warnings: [], summary });
  const summaryOf = edl => (edl && typeof edl === 'object' && !Array.isArray(edl) ? edlCutSummary(edl) : null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(['Request body must be a JSON object with "edl" and optional "transcript".']);
  }
  let edl = body.edl;
  if (typeof edl === 'string') {
    try {
      edl = JSON.parse(edl);
    } catch {
      return fail(['EDL is not valid JSON.']);
    }
  }
  let transcript = body.transcript;
  if (transcript === undefined || transcript === null || (typeof transcript === 'string' && transcript.trim() === '')) {
    transcript = null;
  } else if (typeof transcript === 'string') {
    try {
      transcript = JSON.parse(transcript);
    } catch {
      return fail(['Transcript is not valid JSON.']);
    }
  }
  const structural = validateEdlStructure(edl);
  if (!structural.ok) return fail([structural.error], summaryOf(edl));
  const sources = edl.sources && typeof edl.sources === 'object' ? edl.sources : {};
  for (const key of Object.keys(sources)) {
    if (!allowlistedEdlSource(sources[key], null)) {
      return fail([`sources.${key}: must be a bare file name (no paths).`], summaryOf(edl));
    }
  }
  for (const ov of Array.isArray(edl.overlays) ? edl.overlays : []) {
    if (ov && ov.file !== undefined && !allowlistedEdlSource(ov.file, null)) {
      return fail(['Overlay file must be a bare file name (no paths).'], summaryOf(edl));
    }
  }
  if (transcript === null) {
    return { ok: true, status: 'PASS', errors: [], warnings: [], summary: edlCutSummary(edl) };
  }
  const res = checkEdlEvidence(edl, transcript);
  const status = !res.ok ? 'FAILED' : res.warnings.length > 0 ? 'WARNINGS' : 'PASS';
  return { ok: res.ok, status, errors: res.errors, warnings: res.warnings, summary: edlCutSummary(edl) };
}

export function registerVideoEditorRoutes(app) {
  // Primary page: the Video Editor. It no longer embeds the screen recorder.
  app.get('/editor', (req, res) => {
    res.render('video-editor', {
      editorAvailable: isVideoEditorAvailable(),
      editorMaxVideoMb: editorMaxVideoMb(),
      preselectedPath: null,
      activeApp: 'editor'
    });
  });

  // Secondary page: the standalone Screen Recorder (saves to device only).
  app.get('/recorder', (req, res) => {
    res.render('screen-recorder', {
      editorAvailable: isVideoEditorAvailable(),
      activeApp: 'recorder'
    });
  });

  // Export progress polling (local ffmpeg only).
  app.get('/api/admin/video-editor/export-progress', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    const progress = exportProgress.get(id) || { percent: 0, status: 'unknown' };
    res.json(progress);
  });

  // Local-only export cancel.
  app.post('/api/admin/video-editor/cancel-export', (req, res) => {
    const id = (req.body && req.body.id) || req.query.id;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    const child = activeExportsGet(id);
    if (!child) {
      return res.status(400).json({ error: 'No active export with this ID, or it already completed.' });
    }
    try {
      exportProgress.set(id, { percent: 0, status: 'cancelled' });
      child.kill('SIGKILL');
    } catch (err) {
      console.error('Failed to kill ffmpeg child process:', err);
    }
    activeExportsDelete(id);
    res.json({ ok: true, message: 'Export cancelled.' });
  });

  // Local-only EDL evidence validation.
  app.post('/api/admin/edl-evidence/validate', expressJson(), (req, res) => {
    if (!isVideoEditorAvailable()) {
      return res.status(403).json({ ok: false, status: 'FAILED', errors: ['EDL evidence validation is disabled in production.'], warnings: [] });
    }
    const verdict = validateEdlEvidenceRequest(req.body);
    return res.status(verdict.ok ? 200 : 422).json(verdict);
  });

  // Local-only V2 spec generation from a validated EDL. Re-validates
  // server-side; failed validation never produces a spec. Never renders.
  app.post('/api/admin/edl-evidence/generate', expressJson(), (req, res) => {
    if (!isVideoEditorAvailable()) {
      return res.status(403).json({ ok: false, status: 'FAILED', errors: ['EDL evidence validation is disabled in production.'], warnings: [] });
    }
    const verdict = validateEdlEvidenceRequest(req.body);
    if (!verdict.ok) {
      return res.status(422).json({ ...verdict, spec: null, note: 'No V2 spec generated: validation failed.' });
    }
    let edl = req.body && req.body.edl;
    if (typeof edl === 'string') {
      try {
        edl = JSON.parse(edl);
      } catch {
        return res.status(422).json({ ok: false, status: 'FAILED', errors: ['EDL is not valid JSON.'], warnings: [], summary: null, spec: null });
      }
    }
    let spec;
    try {
      spec = edlToSpecV2(edl);
    } catch {
      return res.status(422).json({ ok: false, status: 'FAILED', errors: ['EDL collections are malformed (texts/overlays must be arrays of objects).'], warnings: [], summary: verdict.summary, spec: null });
    }
    const checked = validateSpecV2(spec);
    if (!checked.ok) {
      return res.status(422).json({ ok: false, status: 'FAILED', errors: [checked.error], warnings: verdict.warnings, summary: verdict.summary, spec: null });
    }
    return res.json({ ...verdict, spec: checked.spec });
  });

  // Screen-recording finalize: WebM upload -> MP4 download via local ffmpeg.
  app.post('/api/admin/video-editor/finalize-recording', async (req, res) => {
    try { req.setTimeout(0); } catch {}
    try { res.setTimeout(0); } catch {}
    if (!isVideoEditorAvailable()) {
      return res.status(403).json({ error: 'Recording finalization is available only when the video editor is running locally.' });
    }
    const maxBytes = editorMaxVideoBytes();
    const announced = Number(req.get('content-length'));
    if (Number.isFinite(announced) && announced > maxBytes) {
      return res.status(413).json({ error: 'Recording is too large to finalize.' });
    }
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bvs-screen-recording-'));
    try {
      const inputPath = path.join(tmpDir, 'recording.webm');
      const outputPath = path.join(tmpDir, 'recording.mp4');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) return res.status(413).json({ error: 'Recording is too large to finalize.' });
        chunks.push(chunk);
      }
      if (!size) return res.status(400).json({ error: 'Recording upload was empty.' });
      await writeFile(inputPath, Buffer.concat(chunks, size));
      const args = buildScreenRecordingFfmpegArgs({ inputPath, outputPath });
      const result = await runLocalFfmpeg(args, EDITOR_FFMPEG_TIMEOUT_MS, null, 0);
      if (!result.ok) {
        if (/ENOENT/i.test(result.stderr || '')) {
          return res.status(500).json({ error: 'Local FFmpeg was not found. Install FFmpeg to finalize the recording as MP4.' });
        }
        return res.status(result.timedOut ? 504 : 500).json({ error: 'Could not finalize recording as MP4.' });
      }
      const outStat = await stat(outputPath);
      if (!outStat.isFile() || outStat.size === 0) {
        return res.status(500).json({ error: 'FFmpeg produced an empty MP4.' });
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': outStat.size,
        'Content-Disposition': 'attachment; filename="screen-recording.mp4"',
        'X-Recording-Filename': 'screen-recording.mp4'
      });
      await new Promise((resolvePromise, rejectPromise) => {
        const stream = createReadStream(outputPath);
        stream.on('error', rejectPromise);
        res.on('close', resolvePromise);
        res.on('finish', resolvePromise);
        stream.pipe(res);
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: 'Could not finalize recording as MP4.' });
    } finally {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // Local-only export. Disabled in production before the body is touched.
  app.post('/api/admin/video-editor/export', async (req, res) => {
    try { req.setTimeout(0); } catch {}
    try { res.setTimeout(0); } catch {}
    if (!isVideoEditorAvailable()) {
      return res.status(403).json({ error: 'Video editor is disabled in production. Run the app locally to export.' });
    }
    const boundary = getMultipartBoundary(req.get('content-type') || '');
    if (!boundary) {
      return res.status(400).json({ error: 'Expected multipart/form-data.' });
    }
    let body;
    const maxRequestBytes = editorMaxRequestBytes();
    const maxRequestMb = Math.round(maxRequestBytes / 1048576);
    const announced = Number(req.get('content-length'));
    if (Number.isFinite(announced) && announced > maxRequestBytes) {
      return res.status(413).json({ error: `Upload too large (max ~${maxRequestMb} MB).` });
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBytes) {
          return res.status(413).json({ error: `Upload too large (max ~${maxRequestMb} MB).` });
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    } catch {
      return res.status(400).json({ error: 'Unable to read upload.' });
    }
    let parsed;
    try {
      parsed = parseMultipartForm(body, boundary);
    } catch {
      return res.status(400).json({ error: 'Unable to parse upload.' });
    }
    body = null;
    const specRaw = parsed.fields.spec;
    const specText = Array.isArray(specRaw) ? specRaw[0] : specRaw;
    if (typeof specText !== 'string' || !specText || Buffer.byteLength(specText, 'utf8') > EDITOR_MAX_SPEC_BYTES) {
      return res.status(400).json({ error: 'Missing or oversized edit spec.' });
    }
    let specJson;
    try {
      specJson = JSON.parse(specText);
    } catch {
      return res.status(400).json({ error: 'Edit spec is not valid JSON.' });
    }
    const resRaw = parsed.fields.resolution;
    const resText = Array.isArray(resRaw) ? resRaw[0] : resRaw;
    if (typeof resText === 'string' && resText.trim() !== '') {
      if (!normalizeExportResolution(resText)) {
        return res.status(400).json({ error: 'resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.' });
      }
      specJson.resolution = resText;
    }
    const checked = validateEditSpec(specJson);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const spec = checked.spec;
    if (spec.version === 2) {
      return handleEditorExportV2(req, res, parsed, spec);
    }

    const videoFile = parsed.files.find(f => f.fieldName === 'video');
    if (!videoFile) return res.status(400).json({ error: 'Missing video file.' });
    if (!isAllowedEditorInput(videoFile.filename)) {
      return res.status(400).json({ error: 'Video must be mp4, webm, mov or mkv.' });
    }
    if (videoFile.data.length === 0 || videoFile.data.length > editorMaxVideoBytes()) {
      return res.status(400).json({ error: `Video file is empty or exceeds ${editorMaxVideoMb()} MB.` });
    }
    let imageFiles = parsed.files.filter(f => f.fieldName === 'image' && f.data.length > 0);
    if (imageFiles.length > EDITOR_MAX_IMAGE_FILES) {
      return res.status(400).json({ error: `At most ${EDITOR_MAX_IMAGE_FILES} overlay images.` });
    }
    for (const imageFile of imageFiles) {
      if (!isAllowedEditorImage(imageFile.filename)) {
        return res.status(400).json({ error: 'Overlay image must be png, jpg or webp.' });
      }
      if (imageFile.data.length > EDITOR_MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'Overlay image exceeds 5 MB.' });
      }
    }
    if (spec.images.length > 0) {
      for (let i = 0; i < spec.images.length; i++) {
        const needed = spec.images[i].file;
        if (!Number.isInteger(needed) || needed < 0 || needed >= imageFiles.length) {
          return res.status(400).json({ error: `images[${i}] references an image that was not uploaded.` });
        }
      }
    } else {
      imageFiles = [];
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bvs-video-editor-'));
    try {
      const inPath = path.join(tmpDir, 'input.bin');
      const outPath = path.join(tmpDir, 'edited.mp4');
      await writeFile(inPath, videoFile.data);
      const imgPaths = [];
      for (let i = 0; i < imageFiles.length; i++) {
        const imgPath = path.join(tmpDir, `overlay${i}.bin`);
        await writeFile(imgPath, imageFiles[i].data);
        imgPaths.push(imgPath);
      }
      let argv;
      try {
        const fontFile = (spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) ? findLocalEditorFont() : null;
        if ((spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) && !fontFile) {
          return res.status(400).json({ error: 'Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.' });
        }
        argv = buildFfmpegArgs({ inputPath: inPath, imagePaths: imgPaths, outputPath: outPath, spec, fontFile });
      } catch (err) {
        return res.status(400).json({ error: err?.message || 'Invalid edit spec.' });
      }
      const exportIdRaw = parsed.fields.exportId;
      const exportId = Array.isArray(exportIdRaw) ? exportIdRaw[0] : exportIdRaw;
      let totalDuration = 0;
      const firstProbe = await probeMediaFile(inPath);
      if (firstProbe && firstProbe.duration) {
        totalDuration = firstProbe.duration;
      }
      const result = await runLocalFfmpeg(argv, EDITOR_FFMPEG_TIMEOUT_MS, exportId, totalDuration);
      if (!result.ok) {
        if (result.timedOut) return res.status(504).json({ error: 'Render timed out (10 min limit). Try a shorter clip.' });
        if (/ENOENT/i.test(result.stderr || '')) {
          return res.status(500).json({ error: 'Local ffmpeg was not found. Install FFmpeg on this machine to export.' });
        }
        const tail = String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(-500);
        return res.status(500).json({ error: `Render failed.${tail ? ` ${tail}` : ''}` });
      }
      let outStat;
      try {
        outStat = await stat(outPath);
      } catch {
        return res.status(500).json({ error: 'Render produced no output.' });
      }
      if (!outStat.isFile() || outStat.size === 0) {
        return res.status(500).json({ error: 'Render produced no output.' });
      }
      const downloadName = `edited-${Date.now()}.mp4`;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': outStat.size,
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'X-Export-Filename': downloadName
      });
      await new Promise((resolvePromise, rejectPromise) => {
        const stream = createReadStream(outPath);
        stream.on('error', rejectPromise);
        res.on('close', resolvePromise);
        res.on('finish', resolvePromise);
        stream.pipe(res);
      });
    } finally {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
}

// Local ffmpeg child registry lives in ffmpeg.js; expose tiny accessors so the
// cancel route does not need to reach into the map directly.
function activeExportsGet(id) { return activeExports.get(id); }
function activeExportsDelete(id) { activeExports.delete(id); }

// The EDL routes need a JSON body parser; the standalone app registers one
// explicitly so this module does not depend on the app-level parser order.
function expressJson() { return express.json({ limit: '1mb' }); }
