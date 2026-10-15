/**
 * Standalone 3D Avatar Face Replacement — Temporal Smoothing Filter
 *
 * Implements One-Euro Filter & Exponential Moving Average (EMA) for 3D pose
 * (position x,y,z, Euler pitch/yaw/roll, scale) and 52 ARKit morph target weights.
 * Eliminates jitter while maintaining zero-lag responsiveness during rapid speech/head movement.
 */

export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = null;
    this.lastTime = null;
  }

  filter(x, timestampMs) {
    if (this.xPrev === null || this.lastTime === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.lastTime = timestampMs;
      return x;
    }

    const dt = Math.max((timestampMs - this.lastTime) / 1000, 0.001);
    this.lastTime = timestampMs;

    // Estimate derivative (rate of change)
    const dx = (x - this.xPrev) / dt;
    const edx = this.alpha(dt, this.dCutoff) * dx + (1 - this.alpha(dt, this.dCutoff)) * this.dxPrev;
    this.dxPrev = edx;

    // Calculate adaptive cutoff frequency based on velocity
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const alpha = this.alpha(dt, cutoff);

    const xSmoothed = alpha * x + (1 - alpha) * this.xPrev;
    this.xPrev = xSmoothed;

    return xSmoothed;
  }

  alpha(dt, cutoff) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = null;
    this.lastTime = null;
  }
}

export class AvatarPoseSmoother {
  constructor() {
    this.filters = {
      posX: new OneEuroFilter(1.2, 0.01),
      posY: new OneEuroFilter(1.2, 0.01),
      posZ: new OneEuroFilter(1.2, 0.01),
      scaleW: new OneEuroFilter(0.8, 0.005),
      scaleH: new OneEuroFilter(0.8, 0.005),
      pitch: new OneEuroFilter(1.5, 0.02),
      yaw: new OneEuroFilter(1.5, 0.02),
      roll: new OneEuroFilter(1.5, 0.02)
    };

    this.blendshapeFilters = {};
  }

  smoothPose(transform, timestampMs) {
    if (!transform || !transform.position || !transform.rotation) {
      return transform;
    }

    const pos = transform.position;
    const rot = transform.rotation;
    const scale = transform.scale || { width: 0.3, height: 0.3 };

    const smoothedPos = {
      x: this.filters.posX.filter(pos.x, timestampMs),
      y: this.filters.posY.filter(pos.y, timestampMs),
      z: this.filters.posZ.filter(pos.z, timestampMs)
    };

    const smoothedScale = {
      width: this.filters.scaleW.filter(scale.width, timestampMs),
      height: this.filters.scaleH.filter(scale.height, timestampMs)
    };

    const smoothedRot = {
      pitch: this.filters.pitch.filter(rot.pitch, timestampMs),
      yaw: this.filters.yaw.filter(rot.yaw, timestampMs),
      roll: this.filters.roll.filter(rot.roll, timestampMs)
    };

    return {
      position: smoothedPos,
      scale: smoothedScale,
      rotation: smoothedRot,
      matrix: transform.matrix
    };
  }

  smoothBlendshapes(blendshapes, timestampMs) {
    if (!blendshapes) return blendshapes;

    const smoothed = {};
    for (const [key, value] of Object.entries(blendshapes)) {
      if (!this.blendshapeFilters[key]) {
        this.blendshapeFilters[key] = new OneEuroFilter(2.0, 0.03); // Higher responsiveness for mouth speech
      }
      smoothed[key] = this.blendshapeFilters[key].filter(value, timestampMs);
    }
    return smoothed;
  }

  reset() {
    for (const filter of Object.values(this.filters)) {
      filter.reset();
    }
    this.blendshapeFilters = {};
  }
}

export const FilmymojiPoseSmoother = AvatarPoseSmoother;
