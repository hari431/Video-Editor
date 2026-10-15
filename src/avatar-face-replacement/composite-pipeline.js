/**
 * Standalone 3D Avatar Face Replacement — Composite Pipeline Module
 *
 * Orchestrates video frame playback, landmark detection, Three.js 3D avatar rendering,
 * and background video compositing in real-time.
 */

import { AvatarFaceTracker } from './face-tracker.js';
import { AvatarFaceRenderer } from './avatar-renderer.js';

export class AvatarCompositePipeline {
  constructor(videoElement, canvasElement, THREE) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.THREE = THREE;

    this.tracker = new AvatarFaceTracker({ numFaces: 1 });
    this.renderer = new AvatarFaceRenderer(canvasElement, THREE);

    this.isRunning = false;
    this.animationFrameId = null;
    this.showLandmarkOverlay = true;
    this.showAvatarOverlay = true;

    this.telemetry = {
      fps: 0,
      facesDetected: 0,
      jawOpen: 0,
      blinkLeft: 0,
      blinkRight: 0,
      yaw: 0,
      pitch: 0,
      roll: 0
    };

    this.frameCount = 0;
    this.lastFpsTime = performance.now();
  }

  async initialize(visionModule, avatarMesh) {
    await this.tracker.initialize(visionModule);

    const width = this.video.videoWidth || 1280;
    const height = this.video.videoHeight || 720;

    this.canvas.width = width;
    this.canvas.height = height;

    this.renderer.initScene(width, height);
    this.renderer.attachAvatarMesh(avatarMesh);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.renderLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  renderLoop() {
    if (!this.isRunning) return;

    const now = performance.now();
    this.frameCount++;
    if (now - this.lastFpsTime >= 1000) {
      this.telemetry.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    if (this.video && !this.video.paused && !this.video.ended) {
      const timestampMs = performance.now();

      // 1. Draw video background frame to canvas
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

      // 2. Execute Face Tracking
      const trackingResult = this.tracker.detectFrame(this.video, timestampMs);

      if (trackingResult && trackingResult.ok && trackingResult.facesCount > 0) {
        const face = trackingResult.faces[0];
        this.telemetry.facesDetected = trackingResult.facesCount;

        // Telemetry update
        this.telemetry.jawOpen = face.blendshapes.jawOpen || 0;
        this.telemetry.blinkLeft = face.blendshapes.eyeBlinkLeft || 0;
        this.telemetry.blinkRight = face.blendshapes.eyeBlinkRight || 0;
        this.telemetry.yaw = face.transform.rotation.yaw || 0;
        this.telemetry.pitch = face.transform.rotation.pitch || 0;
        this.telemetry.roll = face.transform.rotation.roll || 0;

        // 3. Render 3D Avatar Overlay
        if (this.showAvatarOverlay) {
          this.renderer.updateFromFaceData(face, this.canvas.width, this.canvas.height);
        }

        // 4. Render Landmark Mesh Debug Overlay (Optional)
        if (this.showLandmarkOverlay && face.landmarks) {
          this.drawLandmarksOverlay(face.landmarks);
        }
      } else {
        this.telemetry.facesDetected = 0;
      }
    }

    this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
  }

  drawLandmarksOverlay(landmarks) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.fillStyle = '#00ffcc';
    for (let i = 0; i < landmarks.length; i += 4) { // Subsample landmarks for clean overlay
      const pt = landmarks[i];
      ctx.beginPath();
      ctx.arc(pt.x * w, pt.y * h, 2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

export const FilmymojiCompositePipeline = AvatarCompositePipeline;
