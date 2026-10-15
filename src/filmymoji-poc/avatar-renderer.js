/**
 * Standalone Filmymoji POC — 3D Avatar Renderer Module
 *
 * Three.js WebGL 3D Character Avatar Head Renderer with Phase 2 Temporal Smoothing.
 * Synchronizes 3D head position, scale, rotation (quaternion / Euler pitch, yaw, roll),
 * eye rotation, jaw opening, lip movement, and blinking using 52 ARKit morph target weights.
 */

import { FilmymojiPoseSmoother } from './smoothing-filter.js';

export class FilmymojiAvatarRenderer {
  constructor(canvasElement, THREE) {
    this.canvas = canvasElement;
    this.THREE = THREE;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.avatarMesh = null;
    this.morphTargetMap = {};
    this.isInitialized = false;
    this.smoother = new FilmymojiPoseSmoother();
    this.enableSmoothing = true;
  }

  /**
   * Initialize Three.js scene, perspective camera, and lighting.
   */
  initScene(width = 1280, height = 720) {
    const THREE = this.THREE;

    this.scene = new THREE.Scene();

    // Perspective camera aligned with video aspect ratio
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(0, 0, 3);

    // WebGL Renderer with transparent canvas background
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0); // Completely transparent background

    // Lighting setup for 3D character shading
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight1.position.set(2, 4, 3);
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x90b0ff, 0.9);
    dirLight2.position.set(-2, -2, 2);
    this.scene.add(dirLight2);

    this.isInitialized = true;
  }

  /**
   * Load or attach a 3D Character Avatar Head Mesh with Morph Targets.
   */
  attachAvatarMesh(mesh) {
    if (!this.scene) return;

    if (this.avatarMesh) {
      this.scene.remove(this.avatarMesh);
    }

    this.avatarMesh = mesh;
    this.scene.add(this.avatarMesh);

    // Build dictionary map of morph target names (ARKit category names)
    this.morphTargetMap = {};
    if (this.avatarMesh.morphTargetDictionary) {
      for (const [name, index] of Object.entries(this.avatarMesh.morphTargetDictionary)) {
        this.morphTargetMap[name] = index;
      }
    }
  }

  /**
   * Synchronize 3D avatar head pose, position, rotation, and facial expressions
   * from single face tracking payload with Phase 2 temporal smoothing.
   */
  updateFromFaceData(faceData, videoWidth = 1280, videoHeight = 720, timestampMs = performance.now()) {
    if (!this.avatarMesh || !faceData) return;

    let transform = faceData.transform;
    let blendshapes = faceData.blendshapes;

    // Phase 2 Temporal Smoothing
    if (this.enableSmoothing && transform) {
      transform = this.smoother.smoothPose(transform, timestampMs);
      blendshapes = this.smoother.smoothBlendshapes(blendshapes, timestampMs);
    }

    // 1. Update 3D Head Position & Perspective Scaling to cover real face
    if (transform && transform.position) {
      // Map normalized [0, 1] screen coords to Three.js camera coordinate space
      const screenX = (transform.position.x - 0.5) * 2;
      const screenY = -(transform.position.y - 0.5) * 2;

      // Distance estimation based on face width/height
      const distanceScale = (transform.scale ? transform.scale.width : 0.3) * 3;

      this.avatarMesh.position.x = screenX * 1.2;
      this.avatarMesh.position.y = screenY * 0.8 + 0.12; // Refined neck alignment
      this.avatarMesh.position.z = -0.2;

      const baseScale = 1.65 + distanceScale;
      this.avatarMesh.scale.set(baseScale, baseScale, baseScale);
    }

    // 2. Update 3D Head Rotation (Pitch, Yaw, Roll)
    if (transform && transform.rotation) {
      this.avatarMesh.rotation.x = transform.rotation.pitch;
      this.avatarMesh.rotation.y = -transform.rotation.yaw;
      this.avatarMesh.rotation.z = -transform.rotation.roll;
    }

    // 3. Update Facial Expression Morph Targets (Jaw, Mouth, Eyes, Eyebrows)
    if (blendshapes && this.avatarMesh.morphTargetInfluences) {
      for (const [shapeName, weight] of Object.entries(blendshapes)) {
        const morphIndex = this.morphTargetMap[shapeName];
        if (morphIndex !== undefined) {
          this.avatarMesh.morphTargetInfluences[morphIndex] = Math.min(Math.max(weight, 0), 1);
        }
      }
    }

    // Render 3D Scene
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Toggle temporal smoothing ON/OFF.
   */
  setSmoothingEnabled(enabled) {
    this.enableSmoothing = Boolean(enabled);
    if (!enabled) {
      this.smoother.reset();
    }
  }

  /**
   * Resize renderer viewport to match video or display container.
   */
  resizeViewport(width, height) {
    if (!this.renderer || !this.camera) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
