// poc/edl-verify/server.mjs — POC-local browser UI backend (Phase 1 prototype).
// Zero dependencies (node:http only — the main app uses Express, but this POC
// must not add dependencies). Binds 127.0.0.1 only. Never renders, never
// touches production code, never writes outside this POC directory.
//
// Endpoints:
//   GET  /                        -> ui.html
//   GET  /api/sources             -> allowlisted video files in public/
//   GET  /api/samples             -> existing fixtures + sample transcript (read-only)
//   POST /api/validate {edl, transcript?} -> structural (+evidence, if given)
//   POST /api/generate {edl, transcript?} -> re-validates, then writes a V2
//                                            spec ONLY on success (422 otherwise)
//
// Security: uploads arrive as JSON bodies (1MB cap), never as paths. Every
// EDL `sources` value must be a bare filename present in public/ (anything
// with /, \, or absolute form is rejected) so no client input can steer
// filesystem access. Validation itself reuses adapter.mjs in a child process;
// no validation logic is duplicated here beyond presenting its results.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(here, 'public');
const outDir = path.join(here, 'out');
const adapter = path.join(here, 'adapter.mjs');
const PORT = Number(process.env.POC_UI_PORT || 4179);
const BODY_LIMIT = 1024 * 1024;

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);

function listSources() {
  mkdirSync(pubDir, { recursive: true });
  return readdirSync(pubDir, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

// Every sources value must be a bare filename from the allowlist. Returns the
// allowlisted name or null when rejected (path traversal / unknown file).
function allowlistedSource(value, allow) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (value.includes('/') || value.includes('\\') || path.isAbsolute(value)) return null;
  if (value.startsWith('.') || value !== path.basename(value)) return null;
  return allow.includes(value) ? value : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('body too large (max 1MB)'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function asObject(input) {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input !== 'string') throw Object.assign(new Error('expected a JSON object or JSON string'), { code: 400 });
  try {
    const parsed = JSON.parse(input);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('malformed JSON'), { code: 400 });
  }
}

// Readable cut summary: kept ranges, removed intervals, expected duration.
// Removed intervals are gaps between kept ranges (per source) from 0 to the
// furthest kept end; trailing content beyond the last kept range is unknown
// without a probed duration, so it is reported as unknown, not removed.
function cutSummary(edl) {
  const ranges = Array.isArray(edl.ranges) ? edl.ranges : [];
  const kept = ranges.map((r) => ({
    source: r.source,
    start: Number(r.start),
    end: Number(r.end),
    duration: Math.round((Number(r.end) - Number(r.start)) * 1000) / 1000,
    beat: r.beat || null,
  }));
  const bySource = new Map();
  for (const k of kept) {
    if (!Number.isFinite(k.start) || !Number.isFinite(k.end)) continue;
    if (!bySource.has(k.source)) bySource.set(k.source, []);
    bySource.get(k.source).push(k);
  }
  const removed = [];
  for (const [source, list] of bySource) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const k of sorted) {
      if (k.start > cursor) removed.push({ source, start: cursor, end: k.start });
      cursor = Math.max(cursor, k.end);
    }
  }
  const expectedDuration = Math.round(kept.reduce((n, k) => n + (Number.isFinite(k.duration) ? k.duration : 0), 0) * 1000) / 1000;
  return { kept, removed, expectedDuration, trailingUnknown: true };
}

// Run adapter.mjs in a child process against temp inputs. Tmp outputs point
// at throwaway names; callers decide whether to keep them. Always cleans up
// the temp INPUT files. Returns { status, stdout, stderr }.
function runAdapter(edlObj, transcriptObjOrNull, outBase) {
  mkdirSync(outDir, { recursive: true });
  const rand = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const edlFile = path.join(outDir, `tmp-ui-${rand}.edl.json`);
  const specFile = path.join(outDir, `tmp-ui-${rand}.v2spec.json`);
  const assetsFile = path.join(outDir, `tmp-ui-${rand}.assets.json`);
  let txFile = null;
  try {
    writeFileSync(edlFile, JSON.stringify(edlObj));
    const args = [adapter, path.relative(here, edlFile), path.relative(here, specFile), path.relative(here, assetsFile)];
    if (transcriptObjOrNull !== null && transcriptObjOrNull !== undefined) {
      txFile = path.join(outDir, `tmp-ui-${rand}.transcript.json`);
      writeFileSync(txFile, JSON.stringify(transcriptObjOrNull));
      args.push('--evidence', path.relative(here, txFile));
    }
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, cwd: here });
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      specFile, assetsFile,
      error: r.error ? String(r.error.message || r.error) : null,
    };
  } finally {
    for (const f of [edlFile, txFile]) {
      try { if (f && existsSync(f)) unlinkSync(f); } catch { /* best effort */ }
    }
  }
}

function parseAdapterResult(run) {
  const errors = [];
  const warnings = [];
  for (const line of run.stderr.split('\n')) {
    if (line.includes('adapter warning:')) warnings.push(line.slice(line.indexOf('adapter warning:') + 17).trim());
    else if (/adapter (evidence )?FAIL:/.test(line)) errors.push(line.trim());
  }
  if (run.error) errors.push(`adapter could not run: ${run.error}`);
  const ok = run.status === 0 && errors.length === 0;
  const status = !ok ? 'FAILED' : warnings.length > 0 ? 'WARNINGS' : 'PASS';
  return { ok, status, errors, warnings };
}

async function handleValidate(body) {
  let edl;
  try {
    edl = asObject(body.edl);
  } catch (e) {
    return { code: e.code || 400, payload: { ok: false, status: 'FAILED', errors: [e.message], warnings: [] } };
  }
  let transcript = null;
  if (body.transcript !== undefined && body.transcript !== null && String(body.transcript).trim() !== '') {
    try {
      transcript = asObject(body.transcript);
    } catch (e) {
      return { code: e.code || 400, payload: { ok: false, status: 'FAILED', errors: [`transcript: ${e.message}`], warnings: [] } };
    }
  }
  // Source allowlist gate (server-side, before the adapter ever runs).
  const allow = listSources();
  const sources = edl.sources && typeof edl.sources === 'object' ? edl.sources : {};
  for (const [key, value] of Object.entries(sources)) {
    if (!allowlistedSource(value, allow)) {
      return { code: 422, payload: { ok: false, status: 'FAILED', errors: [`sources.${key}: must be a video file available in this POC (got ${JSON.stringify(value)})`], warnings: [] } };
    }
  }
  // Overlay files ride the same gate.
  for (const ov of Array.isArray(edl.overlays) ? edl.overlays : []) {
    if (ov && ov.file !== undefined && !allowlistedSource(ov.file, allow)) {
      return { code: 422, payload: { ok: false, status: 'FAILED', errors: [`overlay file must be a video file available in this POC (got ${JSON.stringify(ov.file)})`], warnings: [] } };
    }
  }
  const run = runAdapter(edl, transcript, null);
  // Validation runs use throwaway outputs: remove them so validation alone
  // never leaves a V2 spec behind.
  for (const f of [run.specFile, run.assetsFile]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* best effort */ }
  }
  const verdict = parseAdapterResult(run);
  return { code: verdict.ok ? 200 : 422, payload: { ...verdict, summary: cutSummary(edl) } };
}

async function handleGenerate(body) {
  const checked = await handleValidate(body);
  if (!checked.payload.ok) {
    return { code: 422, payload: { ...checked.payload, specFile: null, note: 'No V2 spec generated: validation failed.' } };
  }
  // Validation passed (throwaway outputs already removed): run once more with
  // persistent output names. The adapter is deterministic for fixed inputs.
  let edl = asObject(body.edl);
  let transcript = null;
  if (body.transcript !== undefined && body.transcript !== null && String(body.transcript).trim() !== '') {
    transcript = asObject(body.transcript);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const specName = path.join('out', `ui-${stamp}-v2spec.json`);
  const assetsName = path.join('out', `ui-${stamp}-assets.json`);
  const real = runAdapterWithOutputs(edl, transcript, specName, assetsName);
  if (real.status !== 0) {
    return { code: 500, payload: { ok: false, status: 'FAILED', errors: ['generate re-run failed unexpectedly; no spec kept.'], warnings: [], specFile: null } };
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(path.join(here, specName), 'utf8'));
  } catch {
    return { code: 500, payload: { ok: false, status: 'FAILED', errors: ['generated spec unreadable; see server log.'], warnings: [], specFile: null } };
  }
  return { code: 200, payload: { ...checked.payload, spec, specFile: specName } };
}

// Variant of runAdapter that keeps the named outputs (used only after a
// passing validation, for the explicit Generate step).
function runAdapterWithOutputs(edlObj, transcriptObjOrNull, specName, assetsName) {
  mkdirSync(outDir, { recursive: true });
  const rand = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const edlFile = path.join(outDir, `tmp-ui-${rand}.edl.json`);
  let txFile = null;
  try {
    writeFileSync(edlFile, JSON.stringify(edlObj));
    const args = [adapter, path.relative(here, edlFile), specName, assetsName];
    if (transcriptObjOrNull !== null && transcriptObjOrNull !== undefined) {
      txFile = path.join(outDir, `tmp-ui-${rand}.transcript.json`);
      writeFileSync(txFile, JSON.stringify(transcriptObjOrNull));
      args.push('--evidence', path.relative(here, txFile));
    }
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, cwd: here });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message || r.error) : null };
  } finally {
    for (const f of [edlFile, txFile]) {
      try { if (f && existsSync(f)) unlinkSync(f); } catch { /* best effort */ }
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(path.join(here, 'ui.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sources') {
      send(res, 200, { sources: listSources() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/samples') {
      const read = (n) => JSON.parse(readFileSync(path.join(here, n), 'utf8'));
      send(res, 200, { edlReal: read('edl.real.fixture.json'), edlSynthetic: read('edl.fixture.json'), transcript: read('transcript.sample.json') });
      return;
    }
    if ((req.method === 'POST' && (url.pathname === '/api/validate' || url.pathname === '/api/generate'))) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        send(res, e.code || 400, { ok: false, status: 'FAILED', errors: [e.message], warnings: [] });
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
      } catch {
        send(res, 400, { ok: false, status: 'FAILED', errors: ['malformed JSON request body'], warnings: [] });
        return;
      }
      const out = url.pathname === '/api/validate' ? await handleValidate(body) : await handleGenerate(body);
      send(res, out.code, out.payload);
      return;
    }
    send(res, 404, { ok: false, status: 'FAILED', errors: ['not found'], warnings: [] });
  } catch (e) {
    try {
      send(res, 500, { ok: false, status: 'FAILED', errors: ['internal error'], warnings: [] });
    } catch { /* connection already gone */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[edl-ui] listening on http://127.0.0.1:${PORT} (local only)`);
});
