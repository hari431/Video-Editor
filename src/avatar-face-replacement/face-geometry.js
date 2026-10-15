/**
 * Standalone 3D Avatar Face Replacement — Face Geometry Measurement
 *
 * Pure landmark-measurement helpers (no DOM, no THREE, no network).
 * Converts 478 MediaPipe face landmarks into scale-invariant facial
 * proportions used to FIT the personalized avatar head — replacing the
 * previous "one generic head shape for every photo" limitation.
 *
 * All measurements are ratios (resolution / face-size independent).
 * Every function is conservative: low-confidence input yields null so the
 * caller falls back to the validated procedural defaults. Never invent
 * anatomy the input cannot support.
 */

// MediaPipe face-oval contour (temple → jaw → chin → jaw → temple).
export const FACE_OVAL_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
];

// Stable anchor indices (verified against MediaPipe topology + our tracker).
export const IDX = {
  foreheadTop: 10,
  chinBottom: 152,
  noseTip: 1,
  noseBottom: 2,
  eyeOuterL: 33,
  eyeOuterR: 263,
  eyeInnerL: 133,
  eyeInnerR: 362,
  mouthCornerL: 61,
  mouthCornerR: 291,
  lipUpper: 13,
  lipLower: 14,
  lipInnerL: 78,
  lipInnerR: 308
};

function pt(landmarks, i) {
  const p = landmarks[i];
  if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return null;
  return p;
}

export function dist2D(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Validate landmarks well enough to support measurement.
 * Returns null when the input cannot support a claim (wrong count, NaN,
 * tiny/huge face, strongly non-frontal). Conservative by design.
 */
export function checkLandmarkUsability(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;
  const forehead = pt(landmarks, IDX.foreheadTop);
  const chin = pt(landmarks, IDX.chinBottom);
  const eyeL = pt(landmarks, IDX.eyeOuterL);
  const eyeR = pt(landmarks, IDX.eyeOuterR);
  if (!forehead || !chin || !eyeL || !eyeR) return null;

  const faceHeight = dist2D(forehead, chin);
  if (!(faceHeight > 0.08)) return null; // face too small to measure

  // Bounding-box sanity (must be a face-sized region, not full-frame noise).
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const i of FACE_OVAL_INDICES) {
    const p = pt(landmarks, i);
    if (!p) return null;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const area = (maxX - minX) * (maxY - minY);
  if (!(area > 0.015 && area < 0.85)) return null;

  // Frontal check: outer eye corners should sit at similar depth.
  if (Math.abs(eyeL.z - eyeR.z) > 0.06) return null;

  return { faceHeight, bbox: { minX, maxX, minY, maxY, area } };
}

/**
 * Measure scale-invariant facial proportions.
 * Returns a metrics object or null when unsupported.
 *
 * metrics = {
 *   cheekWidth, jawWidth, foreheadWidth (in units of faceHeight),
 *   eyeSpacingRatio, eyeYRel, mouthRatio, mouthYRel, noseLenRel,
 *   faceShape: 'oval' | 'round' | 'square-jaw',
 *   headFit: { sx, sy, jaw }   // continuous three.js head-scale factors
 *   eyes: { xRel, yRel }       // head-local placement hints
 *   mouth: { halfWidthRel, yRel }
 * }
 */
export function measureFaceLandmarks(landmarks) {
  const usable = checkLandmarkUsability(landmarks);
  if (!usable) return null;
  const { faceHeight } = usable;

  const forehead = landmarks[IDX.foreheadTop];
  const chin = landmarks[IDX.chinBottom];
  const eyeL = landmarks[IDX.eyeOuterL];
  const eyeR = landmarks[IDX.eyeOuterR];
  const mouthL = pt(landmarks, IDX.mouthCornerL);
  const mouthR = pt(landmarks, IDX.mouthCornerR);
  const lipU = pt(landmarks, IDX.lipUpper);
  const lipLo = pt(landmarks, IDX.lipLower);
  const noseTip = pt(landmarks, IDX.noseTip);
  const noseBottom = pt(landmarks, IDX.noseBottom);
  if (!mouthL || !mouthR || !lipU || !lipLo || !noseTip || !noseBottom) return null;

  // Widths sampled from the oval contour in thirds of face height.
  const top = forehead.y;
  const bottom = chin.y;
  const span = bottom - top;
  if (!(span > 0.05)) return null;
  let foreW = 0, cheekW = 0, jawW = 0;
  const bandExtent = (y0, y1) => {
    let lo = Infinity, hi = -Infinity;
    for (const i of FACE_OVAL_INDICES) {
      const p = landmarks[i];
      if (p.y >= y0 && p.y <= y1) {
        if (p.x < lo) lo = p.x;
        if (p.x > hi) hi = p.x;
      }
    }
    return hi > lo ? hi - lo : 0;
  };
  foreW = bandExtent(top, top + span * 0.33);
  cheekW = bandExtent(top + span * 0.33, top + span * 0.66);
  jawW = bandExtent(top + span * 0.66, bottom + 0.02);
  if (!(foreW > 0.03 && cheekW > 0.03 && jawW > 0.02)) return null;

  // Normalize by face height → scale-invariant.
  const fw = foreW / faceHeight;
  const cw = cheekW / faceHeight;
  const jw = jawW / faceHeight;

  const eyeSpacing = dist2D(eyeL, eyeR) / faceHeight;
  const eyeY = (eyeL.y + eyeR.y) / 2;
  const eyeYRel = (eyeY - top) / span;
  const mouthWidth = dist2D(mouthL, mouthR) / faceHeight;
  const mouthY = (lipU.y + lipLo.y) / 2;
  const mouthYRel = (mouthY - top) / span;
  const noseLenRel = dist2D(noseTip, noseBottom) / faceHeight;

  // Sanity ranges for a human face (rejects mis-detections conservatively).
  if (!(eyeSpacing > 0.15 && eyeSpacing < 0.75)) return null;
  if (!(eyeYRel > 0.25 && eyeYRel < 0.62)) return null;
  if (!(mouthYRel > 0.55 && mouthYRel < 0.95)) return null;
  if (!(mouthWidth > 0.1 && mouthWidth < 0.6)) return null;

  // Shape class from width relationships (kept to the 3 canonical classes).
  const jawCheek = jawW / cheekW;
  let faceShape = 'oval';
  if (cw > 0.86 && jawCheek > 0.78) {
    faceShape = 'round';
  } else if (jawCheek > 0.90) {
    faceShape = 'square-jaw';
  }

  // Continuous head-fit factors around the neutral toon head (1.0, 1.08).
  const headFit = {
    sx: clamp(0.92 + (cw - 0.78) * 0.9, 0.86, 1.10),
    sy: clamp(1.08 + (span / Math.max(cheekW, 1e-6) - 1.28) * 0.25, 1.0, 1.18),
    jaw: clamp(jawCheek, 0.62, 1.0)
  };

  return {
    cheekWidth: cw,
    jawWidth: jw,
    foreheadWidth: fw,
    // Span ratios ( fractions of cheek width). The generator halves them and
    // scales by head half-width: eyeX = eyeSpanRatio/2 * headHalfW.
    eyeSpanRatio: clamp(eyeSpacing / Math.max(cw, 1e-6), 0.55, 1.0),
    eyeYRel,
    mouthSpanRatio: clamp(mouthWidth / Math.max(cw, 1e-6), 0.25, 0.65),
    mouthYRel,
    noseLenRel,
    faceShape,
    headFit,
    eyes: {
      xRel: clamp(eyeSpacing / Math.max(cw, 1e-6) / 2, 0.28, 0.50),
      yRel: eyeYRel
    },
    mouth: {
      halfWidthRel: clamp(mouthWidth / Math.max(cw, 1e-6) / 2, 0.10, 0.30),
      yRel: mouthYRel
    }
  };
}

/**
 * Conservative stubble estimator on raw 128x128 photo pixels.
 * Returns true only with strong, skin-confident evidence. Best-effort:
 * false negatives preferred over painted-on beards.
 */
export function estimateStubbleFromPixels(imgData128) {
  if (!imgData128 || imgData128.length < 128 * 128 * 4) return false;
  let dark = 0, skin = 0, total = 0;
  for (let y = 78; y < 105; y++) {
    for (let x = 40; x < 88; x++) {
      const idx = (y * 128 + x) * 4;
      const r = imgData128[idx];
      const g = imgData128[idx + 1];
      const b = imgData128[idx + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      total++;
      // Warm skin pixel?
      if (r - b > 12 && lum > 70 && lum < 235) skin++;
      // Dark non-grey pixel (hair-like)?
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (lum < 110 && mx - mn > 12) dark++;
    }
  }
  if (total === 0) return false;
  // Needs BOTH: clearly skin-present jaw AND substantial dark coverage.
  return skin / total > 0.25 && dark / total > 0.30;
}

/**
 * Run MediaPipe FaceLandmarker (IMAGE mode) on a photo element.
 * Creates and caches its own landmarker so the VIDEO-mode video tracker
 * is never disturbed. Resolves to landmarks array or null.
 */
let cachedPhotoLandmarker = null;
let cachedPhotoLandmarkerFailed = false;

export async function detectPhotoLandmarks(visionModule, imageElement) {
  if (!visionModule || !imageElement) return null;
  if (cachedPhotoLandmarkerFailed) return null;
  try {
    const { FaceLandmarker, FilesetResolver } = visionModule;
    if (!FaceLandmarker || !FilesetResolver) return null;
    if (!cachedPhotoLandmarker) {
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      cachedPhotoLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'CPU'
        },
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        runningMode: 'IMAGE',
        numFaces: 1
      });
    }
    const res = await cachedPhotoLandmarker.detect(imageElement);
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!lm || lm.length < 468) return null;
    return lm;
  } catch (e) {
    cachedPhotoLandmarkerFailed = true;
    cachedPhotoLandmarker = null;
    return null;
  }
}

export function _resetPhotoLandmarkerCacheForTests() {
  cachedPhotoLandmarker = null;
  cachedPhotoLandmarkerFailed = false;
}
