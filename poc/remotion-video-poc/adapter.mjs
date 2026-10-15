// poc/remotion-video-poc/adapter.mjs — READ-ONLY adapter.
// Reuses the existing project model WITHOUT duplicating or modifying it:
//   - imports fractions/geometry helpers from ../../src/public/video-editor-project.js
//   - maps the manual EDL fixture (edl.fixture.json) to Remotion inputProps
//     AND to the existing V2 spec shape (for buildV2Args comparison).
// Run: node adapter.mjs  (writes edl.input-props.json + edl.v2spec.json)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  VIDEO_OVERLAY_DEFAULT_W,
  WATERMARK_DEFAULT_POSITION,
} from '../../src/public/video-editor-project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edl = JSON.parse(readFileSync(path.join(here, 'edl.fixture.json'), 'utf8'));
const fps = edl.fps || 30;
const toFrames = (s) => Math.round(s * fps);

const range = edl.ranges[0];
const trimIn = range.start;
const total = edl.total_duration_s;
const durationInFrames = toFrames(total);

const ov = edl.overlays[0];
if (!ov && VIDEO_OVERLAY_DEFAULT_W !== 0.28) throw new Error('model drift');

const inputProps = {
  fps,
  width: edl.width,
  height: edl.height,
  durationInFrames,
  main: {
    src: edl.sources.MAIN,
    trimBeforeFrames: toFrames(trimIn),
  },
  overlay: ov
    ? {
        src: ov.file,
        x: ov.x,
        y: ov.y,
        w: ov.w,
        startFrame: toFrames(ov.start_in_output),
        endFrame: toFrames(ov.start_in_output + ov.duration),
        trimBeforeFrames: toFrames(ov.sourceIn || 0),
      }
    : null,
  text: edl.texts[0]
    ? {
        content: edl.texts[0].content,
        x: edl.texts[0].x,
        y: edl.texts[0].y,
        sizeFrac: edl.texts[0].size,
        color: edl.texts[0].color,
        startFrame: toFrames(edl.texts[0].start_in_output),
        endFrame: toFrames(edl.texts[0].end_in_output),
      }
    : null,
  audio: edl.audio
    ? {
        src: edl.audio.file,
        trimBeforeFrames: toFrames(edl.audio.sourceIn || 0),
      }
    : null,
  watermark: edl.watermark?.enabled
    ? {
        text: edl.watermark.text,
        position: edl.watermark.position ?? WATERMARK_DEFAULT_POSITION,
      }
    : null,
};

// Equivalent existing-pipeline V2 spec for the same timeline.
// files: [main video, overlay-source video, audio]. videoOverlays reference
// kind-index 1 (second video). Mirrors validateSpecV2() expectations.
const v2spec = {
  version: 2,
  width: edl.width,
  height: edl.height,
  files: [{ kind: 'video' }, { kind: 'video' }, { kind: 'audio' }],
  videoClips: [
    {
      file: 0,
      sourceIn: range.start,
      sourceOut: range.end,
      start: 0,
      gain: 1,
      volumeDb: 0,
      fadeIn: 0,
      fadeOut: 0,
    },
  ],
  audioClips: [
    {
      file: 0,
      sourceIn: edl.audio?.sourceIn ?? 0,
      sourceOut: (edl.audio?.sourceIn ?? 0) + total,
      start: 0,
      gain: 1,
      volumeDb: 0,
      fadeIn: 0,
      fadeOut: 0,
    },
  ],
  blurs: [],
  texts: edl.texts.map((t) => ({
    text: t.content,
    x: t.x,
    y: t.y,
    size: t.size,
    color: t.color,
    bg: null,
    start: t.start_in_output,
    end: t.end_in_output,
  })),
  images: [],
  videoOverlays: ov
    ? [
        {
          file: 1,
          x: ov.x,
          y: ov.y,
          w: ov.w,
          h: 0.1575,
          start: ov.start_in_output,
          end: ov.start_in_output + ov.duration,
          sourceIn: ov.sourceIn || 0,
          shape: 'rect',
        },
      ]
    : [],
  zooms: [],
  watermark: edl.watermark,
  resolution: 'original',
};

writeFileSync(path.join(here, 'edl.input-props.json'), JSON.stringify(inputProps, null, 2) + '\n');
writeFileSync(path.join(here, 'edl.v2spec.json'), JSON.stringify(v2spec, null, 2) + '\n');
console.log(`adapter ok: ${durationInFrames} frames @${fps}fps, trimIn=${trimIn}s, total=${total}s`);
