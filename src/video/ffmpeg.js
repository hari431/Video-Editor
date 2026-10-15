// src/video/ffmpeg.js — Local ffmpeg/ffprobe helpers for the standalone
// BrowserVideoStudio editor + screen recorder. Ported verbatim from the
// original src/server.js (helpers that used to live inline there) so the
// existing behaviour is preserved without the rest of the monolith.
//
// Local-only by design: these helpers only run a system ffmpeg/ffprobe and
// stream a fresh download back. They never read or write the library.
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import {
  EDITOR_MAX_VIDEO_FILES,
  EDITOR_MAX_AUDIO_FILES,
  EDITOR_MAX_IMAGE_FILES,
  EDITOR_MAX_AUDIO_BYTES,
  EDITOR_MAX_IMAGE_BYTES,
  EDITOR_FFMPEG_TIMEOUT_MS,
  editorMaxVideoBytes,
  editorMaxVideoMb,
  isAllowedEditorInput,
  isAllowedEditorAudio,
  isAllowedEditorImage,
  buildFfmpegArgs
} from '../library/video-editor.js';

// Local ffprobe resolver for the multi-track editor: filter graphs have no
// "optional stream" operator, so companion-audio presence per video file is
// detected up front. Ships with every system FFmpeg install (same local-only
// premise as ffmpeg itself); absence degrades to assume-audio downstream.
export function findLocalFfprobe() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    try {
      const cand = path.join(
        path.dirname(process.env.FFMPEG_PATH),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      );
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return 'ffprobe';
}

// Probe one temp media file. Resolves {hasAudio, duration, width, height} or
// null when ffprobe is unavailable/unparseable (caller falls back safely).
export function probeMediaFile(absPath) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child = null;
    try {
      child = spawn(findLocalFfprobe(), [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,width,height',
        '-show_entries', 'format=duration',
        '-of', 'json',
        absPath
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      done(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(null);
    }, 30000);
    try {
      child.stdout.on('data', chunk => {
        out += chunk.toString('utf8');
        if (out.length > 65536) out = out.slice(-65536);
      });
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const vStream = streams.find(s => s && s.codec_type === 'video') || null;
        const dur = parsed.format ? Number(parsed.format.duration) : NaN;
        done({
          hasAudio: streams.some(s => s && s.codec_type === 'audio'),
          duration: Number.isFinite(dur) ? dur : null,
          width: vStream && typeof vStream.width === 'number' && Number.isFinite(vStream.width) ? Math.round(vStream.width) : null,
          height: vStream && typeof vStream.height === 'number' && Number.isFinite(vStream.height) ? Math.round(vStream.height) : null
        });
      } catch {
        done(null);
      }
    });
  });
}

// Resolve a .ttf font for drawtext (local editor only). Explicit
// VIDEO_EDITOR_FONT wins; otherwise probe common OS locations. Returns the
// path or null. Needed because drawtext without a usable font crashes ffmpeg
// on machines without a working fontconfig (verified on Windows).
export function findLocalEditorFont() {  const candidates = [];
  if (process.env.VIDEO_EDITOR_FONT) candidates.push(process.env.VIDEO_EDITOR_FONT);
  if (process.platform === 'win32') {
    candidates.push('C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/verdana.ttf');
  } else if (process.platform === 'darwin') {
    candidates.push('/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc');
  } else {
    candidates.push(
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans.ttf'
    );
  }
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export const exportProgress = new Map();
export const activeExports = new Map();

// Run a local system ffmpeg render and stream the bytes back. Used only by
// the local editor client; never reads/writes the library or persists.
export function runLocalFfmpeg(argv, timeoutMs, exportId, totalDuration) {
  return new Promise(resolve => {
    if (exportId && totalDuration > 0) {
      exportProgress.set(exportId, { percent: 0, status: 'starting' });
    }
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', ...argv], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (exportId) {
      activeExports.set(exportId, child);
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      const chunkStr = chunk.toString('utf8');
      stderr += chunkStr;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);

      if (exportId && totalDuration > 0) {
        const current = exportProgress.get(exportId);
        if (current && current.status === 'cancelled') {
          return;
        }

        const matches = [...stderr.matchAll(/time=\s*(\d+):(\d+):(\d+)/g)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          const hours = parseInt(lastMatch[1], 10);
          const minutes = parseInt(lastMatch[2], 10);
          const seconds = parseInt(lastMatch[3], 10);
          const currentSecs = hours * 3600 + minutes * 60 + seconds;
          const rawPercent = (currentSecs / totalDuration) * 100;
          const percent = Math.min(99.99, Math.round(rawPercent * 100) / 100);
          exportProgress.set(exportId, { percent, status: 'rendering' });
        }
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (exportId) {
        activeExports.delete(exportId);
        exportProgress.set(exportId, { percent: 0, status: 'failed' });
        setTimeout(() => { exportProgress.delete(exportId); }, 10 * 60 * 1000);
      }
      resolve({ ok: false, timedOut: false, code: null, stderr: error?.message || String(error) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (exportId) {
        activeExports.delete(exportId);
        if (timedOut) {
          exportProgress.set(exportId, { percent: 0, status: 'timedout' });
        } else if (code === 0) {
          exportProgress.set(exportId, { percent: 100, status: 'done' });
        } else {
          const current = exportProgress.get(exportId);
          if (current && current.status === 'cancelled') {
            // Keep status cancelled
          } else {
            exportProgress.set(exportId, { percent: 0, status: 'failed' });
          }
        }
        setTimeout(() => { exportProgress.delete(exportId); }, 10 * 60 * 1000);
      }
      resolve({ ok: timedOut ? false : code === 0, timedOut, code, stderr });
    });
  });
}

// Multi-track export (spec version 2): repeated `video`/`audio`/`image`
// parts index-aligned with spec.files entries of each kind. Probes every
// media file (dims + audio presence + duration bound), renders the v2 graph,
// and streams back a fresh MP4. Temp originals are deleted afterwards; the
// library is never written.
export async function handleEditorExportV2(req, res, parsed, spec) {
  const videoCount = spec.files.filter(f => f.kind === 'video').length;
  const audioCount = spec.files.filter(f => f.kind === 'audio').length;
  const videoParts = parsed.files.filter(f => f.fieldName === 'video');
  const audioParts = parsed.files.filter(f => f.fieldName === 'audio');
  let imageParts = parsed.files.filter(f => f.fieldName === 'image' && f.data.length > 0);
  if (videoParts.length !== videoCount || videoCount < 1 || videoCount > EDITOR_MAX_VIDEO_FILES) {
    return res.status(400).json({ error: 'Uploaded video files do not match the project.' });
  }
  if (audioParts.length !== audioCount || audioCount > EDITOR_MAX_AUDIO_FILES) {
    return res.status(400).json({ error: 'Uploaded audio files do not match the project.' });
  }
  if (imageParts.length > EDITOR_MAX_IMAGE_FILES) {
    return res.status(400).json({ error: `At most ${EDITOR_MAX_IMAGE_FILES} overlay images.` });
  }
  for (const vf of videoParts) {
    if (!vf.data.length || vf.data.length > editorMaxVideoBytes()) {
      return res.status(400).json({ error: `Video file is empty or exceeds ${editorMaxVideoMb()} MB.` });
    }
    if (!isAllowedEditorInput(vf.filename)) {
      return res.status(400).json({ error: 'Video must be mp4, webm, mov or mkv.' });
    }
  }
  for (const af of audioParts) {
    if (!af.data.length || af.data.length > EDITOR_MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'Audio file is empty or exceeds 200 MB.' });
    }
    if (!isAllowedEditorAudio(af.filename)) {
      return res.status(400).json({ error: 'Audio must be mp3, wav, m4a, aac, ogg or flac.' });
    }
  }
  for (const img of imageParts) {
    if (!isAllowedEditorImage(img.filename)) {
      return res.status(400).json({ error: 'Overlay image must be png, jpg or webp.' });
    }
    if (img.data.length > EDITOR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'Overlay image exceeds 5 MB.' });
    }
  }
  if (spec.images.length > 0) {
    for (let i = 0; i < spec.images.length; i++) {
      const needed = spec.images[i].file;
      if (!Number.isInteger(needed) || needed < 0 || needed >= imageParts.length) {
        return res.status(400).json({ error: `images[${i}] references an image that was not uploaded.` });
      }
    }
  } else {
    imageParts = [];
  }
  // Overlay videos reuse the already-uploaded `video` parts by kind-index.
  for (let i = 0; i < (spec.videoOverlays || []).length; i++) {
    const needed = spec.videoOverlays[i].file;
    if (!Number.isInteger(needed) || needed < 0 || needed >= videoParts.length) {
      return res.status(400).json({ error: `videoOverlays[${i}] references a video that was not uploaded.` });
    }
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bvs-video-editor-'));
  try {
    const videoPaths = [];
    for (let i = 0; i < videoParts.length; i++) {
      const p = path.join(tmpDir, `video${i}.bin`);
      await writeFile(p, videoParts[i].data);
      videoPaths.push(p);
    }
    const audioPaths = [];
    for (let i = 0; i < audioParts.length; i++) {
      const p = path.join(tmpDir, `audio${i}.bin`);
      await writeFile(p, audioParts[i].data);
      audioPaths.push(p);
    }
    const imgPaths = [];
    for (let i = 0; i < imageParts.length; i++) {
      const p = path.join(tmpDir, `overlay${i}.bin`);
      await writeFile(p, imageParts[i].data);
      imgPaths.push(p);
    }
    const outPath = path.join(tmpDir, 'edited.mp4');

    // Probe media facts the graph depends on. Missing ffprobe degrades to
    // assume-audio + declared dims (documented local-only behavior).
    const probes = [];
    for (const p of [...videoPaths, ...audioPaths]) probes.push(await probeMediaFile(p));
    const videoProbes = probes.slice(0, videoPaths.length);
    const audioProbes = probes.slice(videoPaths.length);
    for (let i = 0; i < videoProbes.length; i++) {
      const pr = videoProbes[i];
      // Null probe = ffprobe unavailable: skip checks, the render surfaces
      // real errors. A successful probe without dimensions = no video stream.
      if (pr && pr.width === null) {
        return res.status(400).json({ error: `Video file ${i + 1} has no video stream.` });
      }
    }
    for (let i = 0; i < audioProbes.length; i++) {
      const pr = audioProbes[i];
      if (pr && !pr.hasAudio) {
        return res.status(400).json({ error: `Audio file ${i + 1} has no audio stream.` });
      }
    }
    const clipBound = (list, paths, probes, label) => {
      for (const c of list) {
        const pr = probes[c.file];
        if (pr && pr.duration !== null && c.sourceOut > pr.duration + 1.0) {
          return `${label} extends beyond its file duration.`;
        }
      }
      return null;
    };
    const boundErr =
      clipBound(spec.videoClips, videoPaths, videoProbes, 'A video clip') ||
      clipBound(spec.audioClips, audioPaths, audioProbes, 'An audio clip');
    if (boundErr) return res.status(400).json({ error: boundErr });
    // Overlay source ranges must fit their file too (overlay audio is muted,
    // so only the video stream duration matters).
    for (let i = 0; i < (spec.videoOverlays || []).length; i++) {
      const ov = spec.videoOverlays[i];
      const pr = videoProbes[ov.file];
      const need = (ov.sourceIn || 0) + (ov.end - ov.start);
      if (pr && pr.duration !== null && need > pr.duration + 1.0) {
        return res.status(400).json({ error: `videoOverlays[${i}] extends beyond its file duration.` });
      }
    }

    const firstProbe = videoProbes[0] || null;
    const media = {
      width: Math.round(firstProbe && firstProbe.width ? firstProbe.width : spec.width),
      height: Math.round(firstProbe && firstProbe.height ? firstProbe.height : spec.height),
      hasAudio: videoProbes.map(pr => (pr ? pr.hasAudio : true))
    };
    let argv;
    try {
      const fontFile = (spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) ? findLocalEditorFont() : null;
      if ((spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) && !fontFile) {
        return res.status(400).json({ error: 'Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.' });
      }
      argv = buildFfmpegArgs({
        videoPaths, audioPaths, imagePaths: imgPaths, outputPath: outPath, spec, fontFile, media
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid edit spec.' });
    }
    const exportIdRaw = parsed.fields.exportId;
    const exportId = Array.isArray(exportIdRaw) ? exportIdRaw[0] : exportIdRaw;
    let totalDuration = 0;
    for (const c of [...spec.videoClips, ...spec.audioClips]) {
      totalDuration = Math.max(totalDuration, c.start + (c.sourceOut - c.sourceIn));
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
}
