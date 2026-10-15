/**
 * Standalone 3D Avatar Face Replacement — 3D Avatar Renderer Module
 *
 * Three.js WebGL 3D Character Avatar Head Renderer with Phase 2 Temporal Smoothing.
 * Synchronizes 3D head position, scale, rotation (quaternion / Euler pitch, yaw, roll),
 * eye rotation, jaw opening, lip movement, and blinking using 52 ARKit morph target weights.
 */

import { AvatarPoseSmoother } from './smoothing-filter.js';

export class AvatarFaceRenderer {
  constructor(canvasElement, THREE) {
    this.canvas = canvasElement;
    this.THREE = THREE;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.avatarMesh = null;
    this.morphTargetMap = {};
    this.isInitialized = false;
    this.smoother = new AvatarPoseSmoother();
    this.enableSmoothing = true;
    this.calibration = {
      offsetX: 0,
      offsetY: 0,
      scaleMultiplier: 1.0,
      pitchOffset: 0,
      yawOffset: 0,
      rollOffset: 0
    };
  }

  /**
   * Update calibration transform offsets (Position X/Y, Scale Multiplier, Rotation Pitch/Yaw/Roll).
   */
  setCalibration(config = {}) {
    if (typeof config.offsetX === 'number' && !isNaN(config.offsetX)) {
      this.calibration.offsetX = config.offsetX;
    }
    if (typeof config.offsetY === 'number' && !isNaN(config.offsetY)) {
      this.calibration.offsetY = config.offsetY;
    }
    if (typeof config.scaleMultiplier === 'number' && !isNaN(config.scaleMultiplier)) {
      this.calibration.scaleMultiplier = config.scaleMultiplier;
    }
    if (typeof config.pitchOffset === 'number' && !isNaN(config.pitchOffset)) {
      this.calibration.pitchOffset = config.pitchOffset;
    }
    if (typeof config.yawOffset === 'number' && !isNaN(config.yawOffset)) {
      this.calibration.yawOffset = config.yawOffset;
    }
    if (typeof config.rollOffset === 'number' && !isNaN(config.rollOffset)) {
      this.calibration.rollOffset = config.rollOffset;
    }
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
    const pixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(0x000000, 0); // Completely transparent background

    // Lighting setup for 3D character shading.
    // Cautious rebalance: ambient lowered so sculpted forms keep modeling,
    // with a soft sky/ground hemisphere fill so faces stay well-lit against
    // any video background. Key/fill behavior otherwise unchanged.
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(ambientLight);

    if (THREE.HemisphereLight) {
      const hemiLight = new THREE.HemisphereLight(0xfff5ec, 0x5a6a8a, 0.55);
      this.scene.add(hemiLight);
    }

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
    if (this.avatarMesh && this.scene) {
      this.scene.remove(this.avatarMesh);
    }

    this.avatarMesh = mesh;
    if (this.scene) {
      this.scene.add(this.avatarMesh);
    }

    // Build dictionary map of morph target names (ARKit category names)
    this.morphTargetMap = {};
    this.targetMeshes = [];

    const targetMesh = this.avatarMesh.userData?.headMesh || this.avatarMesh;
    this.targetMesh = targetMesh;

    // Search for all meshes with morph targets inside hierarchy
    if (this.avatarMesh.traverse) {
      this.avatarMesh.traverse(child => {
        if (child.morphTargetDictionary && child.morphTargetInfluences) {
          this.targetMeshes.push(child);
          for (const [name, index] of Object.entries(child.morphTargetDictionary)) {
            this.morphTargetMap[name] = index;
          }
        }
      });
    }

    if (this.targetMeshes.length === 0) {
      this.targetMeshes.push(targetMesh);
      if (targetMesh.morphTargetDictionary) {
        for (const [name, index] of Object.entries(targetMesh.morphTargetDictionary)) {
          this.morphTargetMap[name] = index;
        }
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

    // 1. Update 3D Head Position & Perspective Scaling to cover real face tightly + calibration offsets
    if (transform && transform.position) {
      // Map normalized [0, 1] screen coords to Three.js camera coordinate space
      const screenX = (transform.position.x - 0.5) * 2;
      const screenY = -(transform.position.y - 0.5) * 2;

      // Scale face overlay dynamically based on tracked face bounding width
      const faceWidth = transform.scale ? transform.scale.width : 0.22;
      const faceHeight = transform.scale ? transform.scale.height : 0.28;

      // Three.js units offset mapping + User Calibration Offsets
      const posX = screenX * 1.25 + (this.calibration.offsetX || 0);
      const posY = (screenY * 0.95 - 0.05) + (this.calibration.offsetY || 0);
      this.avatarMesh.position.x = posX;
      this.avatarMesh.position.y = posY;
      this.avatarMesh.position.z = -0.1;

      // Scale avatar head to fit face region tightly (approx 0.85 - 1.1 scale) * scaleMultiplier
      const fittedScale = (faceWidth * 3.2 + faceHeight * 1.8) * 0.65;
      const clampedScale = Math.min(Math.max(fittedScale, 0.55), 1.1);
      const scaleMult = (this.calibration.scaleMultiplier !== undefined && !isNaN(this.calibration.scaleMultiplier))
        ? this.calibration.scaleMultiplier
        : 1.0;
      const finalScale = Math.max(0.1, clampedScale * scaleMult);
      this.avatarMesh.scale.set(finalScale, finalScale, finalScale);
    }

    // 2. Fixed front-facing orientation + manual rotation calibration offsets (ignoring automatic tracked head pitch/yaw/roll)
    const pitch = this.calibration.pitchOffset || 0;
    const yaw = this.calibration.yawOffset || 0;
    const roll = this.calibration.rollOffset || 0;
    this.avatarMesh.rotation.x = pitch;
    this.avatarMesh.rotation.y = yaw;
    this.avatarMesh.rotation.z = roll;

    // 3. Update Facial Expression Morph Targets (Jaw, Mouth, Eyes, Eyebrows)
    const meshesToUpdate = (this.targetMeshes && this.targetMeshes.length > 0) ? this.targetMeshes : [this.targetMesh || this.avatarMesh];
    if (blendshapes) {
      for (const [shapeName, weight] of Object.entries(blendshapes)) {
        const w = Math.min(Math.max(weight, 0), 1);
        for (const m of meshesToUpdate) {
          if (m && m.morphTargetDictionary && m.morphTargetInfluences) {
            const idx = m.morphTargetDictionary[shapeName];
            if (idx !== undefined) {
              m.morphTargetInfluences[idx] = w;
            }
          }
        }
      }
    }

    // 4. Drive Blinking & Mouth Motion on explicit Sub-Group Nodes
    if (blendshapes && this.avatarMesh.userData) {
      const {
        leftEyeGroup,
        rightEyeGroup,
        upperLip,
        lowerLip,
        teethUpper,
        teethLower,
        mouthCavity,
        baseMouth
      } = this.avatarMesh.userData;

      // Eye Blinking
      if (leftEyeGroup && blendshapes.eyeBlinkLeft !== undefined) {
        const blinkL = Math.min(Math.max(blendshapes.eyeBlinkLeft, 0), 1);
        leftEyeGroup.scale.y = Math.max(0.05, 1.0 - blinkL * 0.95);
      }
      if (rightEyeGroup && blendshapes.eyeBlinkRight !== undefined) {
        const blinkR = Math.min(Math.max(blendshapes.eyeBlinkRight, 0), 1);
        rightEyeGroup.scale.y = Math.max(0.05, 1.0 - blinkR * 0.95);
      }

      // Mouth Rigging Animations (jawOpen, smile, funnel, pucker)
      const jawOpen = Math.min(Math.max(blendshapes.jawOpen || 0, 0), 1);
      const smileL = blendshapes.mouthSmileLeft || 0;
      const smileR = blendshapes.mouthSmileRight || 0;
      const smile = Math.min(Math.max((smileL + smileR) / 2, 0), 1);
      const funnel = Math.min(Math.max(blendshapes.mouthFunnel || 0, 0), 1);
      const pucker = Math.min(Math.max(blendshapes.mouthPucker || 0, 0), 1);

      if (baseMouth) {
        // Lower Lip & Lower Teeth drop down on jawOpen
        if (lowerLip && baseMouth.lowerLipY !== undefined) {
          lowerLip.position.y = baseMouth.lowerLipY - jawOpen * 0.12 - funnel * 0.04;
        }
        if (teethLower && baseMouth.teethLowerY !== undefined) {
          teethLower.position.y = baseMouth.teethLowerY - jawOpen * 0.10;
        }
        if (mouthCavity && baseMouth.cavityScaleY !== undefined) {
          mouthCavity.scale.y = baseMouth.cavityScaleY * (1.0 + jawOpen * 2.2 + funnel * 0.8);
        }

        // Smile widens & lifts corners; funnel & pucker narrow/protrude
        if (upperLip && lowerLip) {
          const scaleXMult = 1.0 + smile * 0.35 - funnel * 0.35 - pucker * 0.5;
          const finalScaleX = Math.max(0.3, scaleXMult);
          if (baseMouth.upperLipScaleX !== undefined) upperLip.scale.x = baseMouth.upperLipScaleX * finalScaleX;
          if (baseMouth.lowerLipScaleX !== undefined) lowerLip.scale.x = baseMouth.lowerLipScaleX * finalScaleX;

          if (baseMouth.upperLipY !== undefined) {
            upperLip.position.y = baseMouth.upperLipY + smile * 0.03 + funnel * 0.02;
          }

          // Funnel & Pucker protrusion
          const protZ = funnel * 0.08 + pucker * 0.12;
          if (baseMouth.upperLipZ !== undefined) upperLip.position.z = baseMouth.upperLipZ + protZ;
          if (baseMouth.lowerLipZ !== undefined) lowerLip.position.z = baseMouth.lowerLipZ + protZ;
        }
      }
    }

    // Render 3D Scene
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
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

export const FilmymojiAvatarRenderer = AvatarFaceRenderer;
