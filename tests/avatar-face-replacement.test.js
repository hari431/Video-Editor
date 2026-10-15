import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractHeadPoseFromLandmarks,
  computeFaceBoundingBox,
  AvatarFaceTracker
} from '../src/avatar-face-replacement/face-tracker.js';
import {
  OneEuroFilter,
  AvatarPoseSmoother
} from '../src/avatar-face-replacement/smoothing-filter.js';
import { registerAvatarFaceReplacementRoutes } from '../src/avatar-face-replacement/router.js';

test('3D Avatar Face Replacement: extractHeadPoseFromLandmarks calculates correct center and rotation', () => {
  const landmarks = new Array(478).fill(null).map((_, i) => ({ x: 0.5, y: 0.5, z: 0 }));

  landmarks[1] = { x: 0.5, y: 0.5, z: -0.1 }; // Nose tip
  landmarks[152] = { x: 0.5, y: 0.8, z: 0.05 }; // Chin
  landmarks[33] = { x: 0.3, y: 0.4, z: 0.02 }; // Left Eye Outer
  landmarks[263] = { x: 0.7, y: 0.4, z: -0.02 }; // Right Eye Outer

  const pose = extractHeadPoseFromLandmarks(landmarks);

  assert.ok(pose.position);
  assert.equal(typeof pose.position.x, 'number');
  assert.equal(typeof pose.position.y, 'number');
  assert.equal(typeof pose.position.z, 'number');

  assert.ok(pose.rotation);
  assert.equal(typeof pose.rotation.pitch, 'number');
  assert.equal(typeof pose.rotation.yaw, 'number');
  assert.equal(typeof pose.rotation.roll, 'number');

  assert.ok(pose.scale);
  assert.ok(pose.scale.width > 0);
  assert.ok(pose.scale.height > 0);
});

test('3D Avatar Face Replacement: computeFaceBoundingBox returns normalized box coordinates', () => {
  const landmarks = [
    { x: 0.2, y: 0.3, z: 0 },
    { x: 0.8, y: 0.1, z: 0 },
    { x: 0.5, y: 0.9, z: 0 }
  ];

  const bbox = computeFaceBoundingBox(landmarks);

  assert.equal(bbox.minX, 0.2);
  assert.equal(bbox.maxX, 0.8);
  assert.equal(bbox.minY, 0.1);
  assert.equal(bbox.maxY, 0.9);
  assert.ok(Math.abs(bbox.width - 0.6) < 1e-6);
  assert.ok(Math.abs(bbox.height - 0.8) < 1e-6);
});

test('OneEuroFilter: smooths noisy jitter values over sequential frames', () => {
  const filter = new OneEuroFilter(1.0, 0.01);

  const t0 = 1000;
  const t1 = 1033; // ~30 FPS
  const t2 = 1066;

  const v0 = filter.filter(10.0, t0);
  assert.equal(v0, 10.0);

  // Injected high-frequency noise spike (10.0 -> 15.0)
  const v1 = filter.filter(15.0, t1);
  assert.ok(v1 < 15.0, 'Filter should dampen sudden noise spike');
  assert.ok(v1 > 10.0, 'Filter should respond towards target value');

  const v2 = filter.filter(15.0, t2);
  assert.ok(v2 > v1, 'Filter should smoothly converge over time');
});

test('AvatarPoseSmoother: smooths transform and 52 blendshape weights', () => {
  const smoother = new AvatarPoseSmoother();

  const transform0 = {
    position: { x: 0.5, y: 0.5, z: 0 },
    rotation: { pitch: 0, yaw: 0, roll: 0 },
    scale: { width: 0.3, height: 0.3 }
  };

  const transform1 = {
    position: { x: 0.8, y: 0.5, z: 0 }, // Jitter shift
    rotation: { pitch: 0.2, yaw: 0, roll: 0 },
    scale: { width: 0.3, height: 0.3 }
  };

  const smoothed0 = smoother.smoothPose(transform0, 1000);
  assert.equal(smoothed0.position.x, 0.5);

  const smoothed1 = smoother.smoothPose(transform1, 1033);
  assert.ok(smoothed1.position.x < 0.8, 'Position x should be smoothed');
  assert.ok(smoothed1.rotation.pitch < 0.2, 'Rotation pitch should be smoothed');

  const blendshapes = { jawOpen: 0.8, eyeBlinkLeft: 0.1 };
  const smoothedBlendshapes = smoother.smoothBlendshapes(blendshapes, 1033);
  assert.equal(typeof smoothedBlendshapes.jawOpen, 'number');
  assert.equal(typeof smoothedBlendshapes.eyeBlinkLeft, 'number');
});

test('3D Avatar Face Replacement: router registers GET /avatar-face-replacement endpoint', () => {
  const routes = [];
  const middleware = [];
  const mockApp = {
    use(...args) {
      middleware.push(args);
    },
    get(path, handler) {
      routes.push({ path, handler });
    }
  };

  registerAvatarFaceReplacementRoutes(mockApp);

  assert.ok(routes.some(r => r.path === '/avatar-face-replacement'));
  assert.ok(routes.some(r => r.path === '/avatar-face-replacement.html'));
  assert.ok(middleware.some(m => m[0] === '/src/avatar-face-replacement'));
});

test('3D Avatar Face Replacement: HTML contains calibration slider controls, gesture hint badge, and character gallery grid', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync('src/public/avatar-face-replacement.html', 'utf8');

  assert.ok(html.includes('id="btnBrowseFile"'), 'Browse file button/label must exist');
  assert.ok(html.includes('id="btnLoadSample"'), 'Sample video button must exist');
  assert.ok(html.includes('id="videoFileInput"'), 'Video file input must exist');
  assert.ok(html.includes('id="avatarDropzone"'), 'Avatar dropzone container must exist');

  assert.ok(html.includes('id="sliderPosX"'), 'Position X calibration slider must exist');
  assert.ok(html.includes('id="sliderPosY"'), 'Position Y calibration slider must exist');
  assert.ok(html.includes('id="sliderScale"'), 'Scale calibration slider must exist');
  assert.ok(html.includes('id="sliderPitch"'), 'Pitch calibration slider must exist');
  assert.ok(html.includes('id="sliderYaw"'), 'Yaw calibration slider must exist');
  assert.ok(html.includes('id="sliderRoll"'), 'Roll calibration slider must exist');
  assert.ok(html.includes('id="btnResetCalibration"'), 'Reset calibration button must exist');
  assert.ok(html.includes('id="canvasGestureHint"'), 'Canvas Gesture Hint overlay badge must exist');
  assert.ok(html.includes('id="characterGalleryGrid"'), 'Character Gallery Grid container must exist');
  assert.ok(html.includes('id="selectedCharacterBadge"'), 'Selected Character Badge container must exist');

  assert.ok(html.includes('accept="video/mp4,video/webm'), 'Input accept attribute must allow video formats');
  assert.ok(html.includes('for="videoFileInput"'), 'Browse element must be linked to file input via label or click handler');
});

test('AvatarFaceRenderer: setCalibration updates calibration parameters and applies offsets', async () => {
  const { AvatarFaceRenderer } = await import('../src/avatar-face-replacement/avatar-renderer.js');

  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  }

  const mockMesh = {
    position: new Vector3(),
    rotation: new Euler(),
    scale: new Vector3(),
    userData: {}
  };

  const renderer = new AvatarFaceRenderer(null, {});
  renderer.attachAvatarMesh(mockMesh);
  renderer.enableSmoothing = false;

  assert.deepEqual(renderer.calibration, {
    offsetX: 0,
    offsetY: 0,
    scaleMultiplier: 1.0,
    pitchOffset: 0,
    yawOffset: 0,
    rollOffset: 0
  });

  renderer.setCalibration({
    offsetX: 0.5,
    offsetY: -0.25,
    scaleMultiplier: 1.5,
    pitchOffset: 0.1,
    yawOffset: -0.2,
    rollOffset: 0.3
  });

  assert.equal(renderer.calibration.offsetX, 0.5);
  assert.equal(renderer.calibration.offsetY, -0.25);
  assert.equal(renderer.calibration.scaleMultiplier, 1.5);
  assert.equal(renderer.calibration.pitchOffset, 0.1);
  assert.equal(renderer.calibration.yawOffset, -0.2);
  assert.equal(renderer.calibration.rollOffset, 0.3);

  const mockFaceDataWithHeadPose = {
    transform: {
      position: { x: 0.5, y: 0.5, z: 0 },
      rotation: { pitch: 0.75, yaw: -0.65, roll: 0.85 },
      scale: { width: 0.22, height: 0.28 }
    },
    blendshapes: {}
  };

  renderer.updateFromFaceData(mockFaceDataWithHeadPose, 1280, 720, 1000);

  // Position X should include +0.5 offsetX
  assert.ok(Math.abs(mockMesh.position.x - 0.5) < 1e-3, 'Position X should equal 0.0 + 0.5 offset');
  // Position Y should include -0.25 offsetY
  assert.ok(Math.abs(mockMesh.position.y - (-0.30)) < 1e-3, 'Position Y should equal -0.05 + -0.25 offset');
  // Automatic head rotation (pitch/yaw/roll) should be ignored, remaining strictly equal to fixed front-facing + manual calibration offsets
  assert.ok(Math.abs(mockMesh.rotation.x - 0.1) < 1e-3, 'Rotation X (pitch) should remain 0.1 (manual pitchOffset only, ignoring tracked 0.75)');
  assert.ok(Math.abs(mockMesh.rotation.y - (-0.2)) < 1e-3, 'Rotation Y (yaw) should remain -0.2 (manual yawOffset only, ignoring tracked -0.65)');
  assert.ok(Math.abs(mockMesh.rotation.z - 0.3) < 1e-3, 'Rotation Z (roll) should remain 0.3 (manual rollOffset only, ignoring tracked 0.85)');
});

test('3D Avatar Face Replacement: AvatarAssetLoader loads 3D character assets conforming to facial animation contract', async () => {
  const { AvatarAssetLoader, AVATAR_CHARACTER_REGISTRY, AVATAR_CHARACTER_LIST } = await import('../src/avatar-face-replacement/avatar-asset-loader.js');

  assert.ok(AVATAR_CHARACTER_REGISTRY.length >= 16, 'Registry must contain 15 procedural characters + character-01 GLB asset');
  assert.equal(AVATAR_CHARACTER_LIST.length, 15, 'AVATAR_CHARACTER_LIST must contain 15 procedural toon characters');
  
  const char01 = AVATAR_CHARACTER_REGISTRY.find(c => c.id === 'character-01');
  assert.ok(char01, 'character-01 must be present in registry');
  assert.ok(char01.glbUrl.includes('character.glb'), 'character-01 must point to character.glb');
  assert.ok(char01.previewUrl.includes('preview.svg'), 'character-01 must point to preview thumbnail');

  class Vector3 { set() {} }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class BufferGeometry {
    constructor() { this.attributes = { position: new BufferAttribute(new Float32Array(32 * 3), 3) }; this.morphAttributes = {}; }
    scale() {}
    attributes = { position: { count: 32, getX: () => 0, getY: () => 0, getZ: () => 0 } };
  }
  class SphereGeometry extends BufferGeometry {}
  class CylinderGeometry extends BufferGeometry {}
  class ConeGeometry extends BufferGeometry {}
  class BoxGeometry extends BufferGeometry {}
  class TorusGeometry extends BufferGeometry {}
  class MeshToonMaterial {}
  class MeshPhongMaterial {}
  class MeshBasicMaterial {}
  class MeshStandardMaterial {}
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
  }
  class Group {
    constructor() { this.children = []; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
    add(child) { this.children.push(child); }
  }

  const MockTHREE = {
    Group,
    SphereGeometry,
    CylinderGeometry,
    ConeGeometry,
    BoxGeometry,
    TorusGeometry,
    BufferAttribute,
    MeshToonMaterial,
    MeshPhongMaterial,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Mesh
  };

  const loader = new AvatarAssetLoader(MockTHREE);
  const avatarGroup = await loader.loadCharacterAsset('character-01');

  assert.ok(avatarGroup, 'Loaded avatar group must be valid');
  assert.ok(avatarGroup.userData.characterId === 'character-01', 'characterId must match character-01');
  assert.ok(avatarGroup.morphTargetDictionary, 'Morph target dictionary must be present');
  assert.ok(avatarGroup.morphTargetDictionary.jawOpen !== undefined, 'jawOpen blendshape contract must be met');
  assert.ok(avatarGroup.morphTargetDictionary.eyeBlinkLeft !== undefined, 'eyeBlinkLeft blendshape contract must be met');
  assert.ok(avatarGroup.morphTargetDictionary.eyeBlinkRight !== undefined, 'eyeBlinkRight blendshape contract must be met');
});

test('Phase 3B: PersonalCharacterGenerator creates stylized "My Character" from photo features conforming to facial animation contract', async () => {
  const { PersonalCharacterGenerator } = await import('../src/avatar-face-replacement/personal-character-generator.js');
  const { AvatarAssetLoader } = await import('../src/avatar-face-replacement/avatar-asset-loader.js');

  class Vector3 { set() {} }
  class Color { constructor(val) { this.val = val; } }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class BufferGeometry {
    constructor() {
      this.attributes = { position: new BufferAttribute(new Float32Array(32 * 3), 3) };
      this.morphAttributes = {};
    }
    scale() {}
  }
  class SphereGeometry extends BufferGeometry {}
  class BoxGeometry extends BufferGeometry {}
  class TorusGeometry extends BufferGeometry {}
  class MeshStandardMaterial { constructor(opts) { this.opts = opts; } }
  class MeshToonMaterial { constructor(opts) { this.opts = opts; } }
  class MeshBasicMaterial { constructor(opts) { this.opts = opts; } }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
  }
  class Group {
    constructor() { this.children = []; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
    add(...children) { this.children.push(...children); }
  }

  const MockTHREE = {
    Group,
    SphereGeometry,
    BoxGeometry,
    TorusGeometry,
    BufferAttribute,
    MeshStandardMaterial,
    MeshToonMaterial,
    MeshBasicMaterial,
    Mesh,
    Color
  };

  const generator = new PersonalCharacterGenerator(MockTHREE);
  const samplePhotoFeatures = {
    skinColor: '#e0a882',
    hairColor: '#1c1917',
    eyeColor: '#0f172a',
    accentColor: '#3b82f6'
  };

  const previewSvg = generator.generatePreviewSVG(samplePhotoFeatures);
  assert.ok(previewSvg.includes('data:image/svg+xml'), 'Preview SVG must be valid data URL');

  const { characterItem, modelBuilder } = await generator.generatePersonalCharacter(null, MockTHREE);
  assert.equal(characterItem.id, 'my-character');
  assert.equal(characterItem.name, 'My Character');
  assert.ok(characterItem.badge.includes('My Photo Toon'));

  const loader = new AvatarAssetLoader(MockTHREE);
  loader.registerPersonalizedCharacter(characterItem, modelBuilder);

  const myCharacterGroup = await loader.loadCharacterAsset('my-character');
  assert.ok(myCharacterGroup, 'My Character group must load');
  assert.equal(myCharacterGroup.userData.characterId, 'my-character');
  assert.ok(myCharacterGroup.morphTargetDictionary.jawOpen !== undefined, 'jawOpen blendshape present');
  assert.ok(myCharacterGroup.morphTargetDictionary.eyeBlinkLeft !== undefined, 'eyeBlinkLeft blendshape present');
  assert.ok(myCharacterGroup.morphTargetDictionary.eyeBlinkRight !== undefined, 'eyeBlinkRight blendshape present');
});

test('Phase 3C: AvatarFaceRenderer animates mouth, lips, teeth, and eyes in response to jawOpen, smile, funnel, pucker, and eyeBlink', async () => {
  const { AvatarFaceRenderer } = await import('../src/avatar-face-replacement/avatar-renderer.js');
  const { createProcedural3DToonAvatar } = await import('../src/avatar-face-replacement/avatar-model-generator.js');

  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Euler { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
  class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } }
  class BufferGeometry {
    constructor() { this.attributes = { position: new BufferAttribute(new Float32Array(32 * 3), 3) }; this.morphAttributes = {}; }
    scale() {}
  }
  class SphereGeometry extends BufferGeometry {}
  class CylinderGeometry extends BufferGeometry {}
  class ConeGeometry extends BufferGeometry {}
  class BoxGeometry extends BufferGeometry {}
  class TorusGeometry extends BufferGeometry {}
  class MeshToonMaterial {}
  class MeshPhongMaterial {}
  class MeshBasicMaterial {}
  class MeshStandardMaterial {}
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.position = new Vector3();
      this.rotation = new Euler();
      this.scale = new Vector3(1, 1, 1);
    }
  }
  class Group {
    constructor() {
      this.children = [];
      this.position = new Vector3();
      this.rotation = new Euler();
      this.scale = new Vector3(1, 1, 1);
    }
    add(...children) { this.children.push(...children); }
  }

  const MockTHREE = {
    Group,
    SphereGeometry,
    CylinderGeometry,
    ConeGeometry,
    BoxGeometry,
    TorusGeometry,
    BufferAttribute,
    MeshToonMaterial,
    MeshPhongMaterial,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Mesh
  };

  const avatarMesh = createProcedural3DToonAvatar(MockTHREE, 'toon-boy');
  assert.ok(avatarMesh.userData.upperLip, 'upperLip 3D geometry must be present');
  assert.ok(avatarMesh.userData.lowerLip, 'lowerLip 3D geometry must be present');
  assert.ok(avatarMesh.userData.teethUpper, 'teethUpper 3D geometry must be present');
  assert.ok(avatarMesh.userData.teethLower, 'teethLower 3D geometry must be present');
  assert.ok(avatarMesh.userData.mouthCavity, 'mouthCavity 3D geometry must be present');

  const renderer = new AvatarFaceRenderer(null, {});
  renderer.attachAvatarMesh(avatarMesh);
  renderer.enableSmoothing = false;

  const initialLowerLipY = avatarMesh.userData.lowerLip.position.y;
  const initialLeftEyeScaleY = avatarMesh.userData.leftEyeGroup.scale.y;

  const faceDataWithExpressions = {
    transform: { position: { x: 0.5, y: 0.5, z: 0 }, scale: { width: 0.22, height: 0.28 } },
    blendshapes: {
      jawOpen: 0.8,
      mouthSmileLeft: 0.6,
      mouthSmileRight: 0.6,
      eyeBlinkLeft: 0.9,
      eyeBlinkRight: 0.9
    }
  };

  renderer.updateFromFaceData(faceDataWithExpressions, 1280, 720, 1000);

  assert.ok(avatarMesh.userData.lowerLip.position.y < initialLowerLipY, 'Lower lip drops when jaw opens');
  assert.ok(avatarMesh.userData.leftEyeGroup.scale.y < initialLeftEyeScaleY, 'Left eye squints/blinks when eyeBlink is high');
});

function buildSyntheticFrontalLandmarks() {
  const lm = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[10] = { x: 0.5, y: 0.28, z: -0.02 };
  lm[152] = { x: 0.5, y: 0.72, z: 0.02 };
  lm[33] = { x: 0.36, y: 0.42, z: 0.01 };
  lm[263] = { x: 0.64, y: 0.42, z: 0.01 };
  lm[133] = { x: 0.42, y: 0.42, z: 0.02 };
  lm[362] = { x: 0.58, y: 0.42, z: 0.02 };
  lm[61] = { x: 0.42, y: 0.62, z: 0.02 };
  lm[291] = { x: 0.58, y: 0.62, z: 0.02 };
  lm[13] = { x: 0.5, y: 0.60, z: 0.02 };
  lm[14] = { x: 0.5, y: 0.64, z: 0.02 };
  lm[1] = { x: 0.5, y: 0.52, z: -0.03 };
  lm[2] = { x: 0.5, y: 0.56, z: -0.01 };
  const oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  oval.forEach((idx, k) => {
    const a = (k / oval.length) * Math.PI * 2;
    lm[idx] = { x: 0.5 + Math.cos(a) * 0.15, y: 0.5 + Math.sin(a) * 0.22, z: 0 };
  });
  lm[10] = { x: 0.5, y: 0.28, z: 0 };
  lm[152] = { x: 0.5, y: 0.72, z: 0 };
  return lm;
}

function buildAvatarMockTHREE() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  function posAttr(n) {
    return {
      count: n,
      array: new Float32Array(n * 3),
      getX(i) { return this.array[i * 3]; },
      getY(i) { return this.array[i * 3 + 1]; },
      getZ(i) { return this.array[i * 3 + 2]; }
    };
  }
  class BufferGeometry {
    constructor() { this.attributes = { position: posAttr(24) }; this.morphAttributes = {}; }
    scale() {}
  }
  class SphereGeometry extends BufferGeometry {}
  class BoxGeometry extends BufferGeometry {}
  class CylinderGeometry extends BufferGeometry {}
  class ConeGeometry extends BufferGeometry {}
  class TorusGeometry extends BufferGeometry {}
  class IcosahedronGeometry extends BufferGeometry {}
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class Mat { constructor(opts) { this.opts = opts; } }
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material;
      this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1);
    }
  }
  class Group {
    constructor() {
      this.children = []; this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1);
    }
    add(...children) { this.children.push(...children); }
    traverse(fn) { fn(this); for (const ch of this.children) { fn(ch); if (ch.children) for (const g of ch.children) fn(g); } }
  }
  class Color { constructor(val) { this.val = val; } }
  return {
    Group, SphereGeometry, BoxGeometry, CylinderGeometry, ConeGeometry, TorusGeometry,
    IcosahedronGeometry, BufferAttribute, MeshStandardMaterial: Mat, MeshToonMaterial: Mat,
    MeshPhongMaterial: Mat, MeshBasicMaterial: Mat, Mesh, Color
  };
}

test('FaceGeometry: measures frontal landmarks, rejects garbage and non-frontal input', async () => {
  const { measureFaceLandmarks, estimateStubbleFromPixels } = await import('../src/avatar-face-replacement/face-geometry.js');

  const m = measureFaceLandmarks(buildSyntheticFrontalLandmarks());
  assert.ok(m, 'Frontal landmarks must produce metrics');
  assert.ok(['oval', 'round', 'square-jaw'].includes(m.faceShape), 'Shape must be a canonical class');
  assert.ok(m.headFit.sx >= 0.86 && m.headFit.sx <= 1.10, 'Head fit sx must be clamped');
  assert.ok(m.measured !== false, 'Real measurement path must be flagged');

  assert.equal(measureFaceLandmarks(null), null, 'null landmarks must yield null');
  assert.equal(measureFaceLandmarks([]), null, 'Empty landmarks must yield null');
  assert.equal(measureFaceLandmarks(new Array(100).fill({ x: 0, y: 0, z: 0 })), null, 'Short arrays must yield null');

  const turned = buildSyntheticFrontalLandmarks().map(p => ({ ...p }));
  turned[263] = { ...turned[263], z: 0.3 };
  assert.equal(measureFaceLandmarks(turned), null, 'Strongly non-frontal input must yield null');

  assert.equal(estimateStubbleFromPixels(new Uint8ClampedArray(128 * 128 * 4)), false, 'Empty pixels must not claim stubble');
  assert.equal(estimateStubbleFromPixels(null), false, 'Missing pixels must not claim stubble');
});

test('HairCatalogue: legacy names resolve, classification is conservative, assets build for SVG and 3D', async () => {
  const { HAIR_ASSETS, HAIR_ASSET_IDS, resolveHairAsset, classifyHairAsset } = await import('../src/avatar-face-replacement/hair-catalogue.js');

  assert.equal(resolveHairAsset('long-flowing'), 'long-straight', 'Legacy long-flowing must resolve');
  assert.equal(resolveHairAsset('buzz-cut'), 'buzz', 'Legacy buzz-cut must resolve');
  assert.equal(resolveHairAsset('nope'), 'side-part', 'Unknown style must fall back to side-part');

  assert.equal(classifyHairAsset({ topVolume: 100, sideVolume: 500, skinLum: 180, hairLum: 60 }), 'long-straight');
  assert.equal(classifyHairAsset({ topVolume: 100, sideVolume: 0, skinLum: 180, hairLum: 170 }), 'bald', 'Bald needs strong evidence');
  assert.equal(classifyHairAsset({ topVolume: 500, sideVolume: 100, skinLum: 180, hairLum: 60 }), 'side-part', 'Uncertain input must stay a neat default');

  const MockTHREE = buildAvatarMockTHREE();
  class ToonMat { constructor(opts) { this.opts = opts; } }
  for (const id of HAIR_ASSET_IDS) {
    const asset = HAIR_ASSETS[id];
    const svg = asset.svg('#2b1b17');
    assert.equal(typeof svg, 'string', `${id} must produce SVG`);
    if (id !== 'bald') assert.ok(svg.includes('#2b1b17'), `${id} SVG must use the canonical hair color`);
    const built = asset.build3D(MockTHREE, new ToonMat({ color: '#2b1b17' }), { sx: 1 });
    assert.ok(built, `${id} must build a 3D group`);
    if (id === 'bald') assert.equal(built.children.length, 0, 'Bald must build an empty group');
    else assert.ok(built.children.length > 0, `${id} must build a visible mass`);
  }
});

test('My Character: measured landmarks produce structurally different avatars; invalid metrics fall back neutral', async () => {
  const { PersonalCharacterGenerator, canonicalizePersonalFeatures } = await import('../src/avatar-face-replacement/personal-character-generator.js');
  const MockTHREE = buildAvatarMockTHREE();
  const generator = new PersonalCharacterGenerator(MockTHREE);

  const legacy = canonicalizePersonalFeatures({ skinColor: '#e0a882', hairColor: '#1c1917', hairStyle: 'long-flowing' });
  assert.equal(legacy.hair.style, 'long-straight', 'Legacy style names must map to catalogue assets');

  const junkMetrics = canonicalizePersonalFeatures({ skinColor: '#e0a882', metrics: { headFit: { sx: 99, sy: -2 }, eyes: {}, mouth: null } });
  assert.equal(junkMetrics.metrics.measured, false, 'Invalid metrics must fall back to neutral');
  assert.equal(junkMetrics.metrics.headFit.sx, 1.0, 'Neutral head fit sx must be 1.0');

  const narrow = { skinColor: '#e0a882', hairColor: '#1c1917', hairStyle: 'side-part', metrics: { headFit: { sx: 0.88, sy: 1.02, jaw: 0.7 }, eyes: { xRel: 0.34, yRel: 0.44 }, mouth: { halfWidthRel: 0.17, yRel: 0.72 }, measured: true } };
  const wide = { skinColor: '#e0a882', hairColor: '#1c1917', hairStyle: 'long-straight', metrics: { headFit: { sx: 1.08, sy: 1.16, jaw: 0.95 }, eyes: { xRel: 0.44, yRel: 0.38 }, mouth: { halfWidthRel: 0.26, yRel: 0.78 }, measured: true } };
  const m1 = generator.createPersonalized3DToonAvatar(MockTHREE, narrow);
  const m2 = generator.createPersonalized3DToonAvatar(MockTHREE, wide);
  assert.ok(m1.userData.leftEyeGroup.position.x !== m2.userData.leftEyeGroup.position.x, 'Different faces must place eyes differently');
  assert.ok(m1.userData.upperLip.scale.x !== m2.userData.upperLip.scale.x, 'Different faces must size mouths differently');

  const staged1 = generator.createPersonalized3DToonAvatar(MockTHREE, narrow);
  const staged2 = generator.createPersonalized3DToonAvatar(MockTHREE, narrow);
  assert.equal(staged1.userData.leftEyeGroup.position.x, staged2.userData.leftEyeGroup.position.x, 'Same metrics must be deterministic');
});

test('My Character: invalid inputs never throw and never produce grey skin', async () => {
  const { PersonalCharacterGenerator } = await import('../src/avatar-face-replacement/personal-character-generator.js');
  const MockTHREE = buildAvatarMockTHREE();
  const generator = new PersonalCharacterGenerator(MockTHREE);

  assert.equal(generator.createPersonalized3DToonAvatar(null, {}), null, 'Missing THREE must return null');
  const empty = generator.createPersonalized3DToonAvatar(MockTHREE, {});
  assert.ok(empty && empty.userData.headMesh, 'Empty features must still build via canonical defaults');

  const grey = generator.createPersonalized3DToonAvatar(MockTHREE, { skinColor: '#9aa0a6', hairColor: '#757172', eyeColor: '#9aa0a6', accentColor: '#96989e' });
  assert.notEqual(grey.userData.features.skin.color, '#9aa0a6', 'Grey skin input must be sanitized');
  assert.notEqual(grey.userData.features.lips.color, grey.userData.features.clothing.color, 'Lips must stay a separate material from clothing');

  const svg = generator.generatePreviewSVG(null);
  assert.ok(svg.includes('data:image/svg+xml'), 'Null features must still produce a valid thumbnail');

  const fallback = generator.extractPhotoFeatures(null, [{ x: 0, y: 0, z: 0 }]);
  assert.equal(fallback.metrics.measured, false, 'Unusable landmarks must fall back to unmeasured');
});

test('Default characters: all 15 load with full animation contract and symmetric forward framing', async () => {
  const { createProcedural3DToonAvatar, AVATAR_CHARACTER_LIST } = await import('../src/avatar-face-replacement/avatar-model-generator.js');
  const MockTHREE = buildAvatarMockTHREE();

  assert.equal(AVATAR_CHARACTER_LIST.length, 15, 'Gallery must keep all 15 entries');
  const ids = new Set(AVATAR_CHARACTER_LIST.map(c => c.id));
  assert.equal(ids.size, 15, 'Character ids must stay unique');

  for (const char of AVATAR_CHARACTER_LIST) {
    const group = createProcedural3DToonAvatar(MockTHREE, char.id);
    assert.ok(group, `${char.id} must build`);
    for (const key of ['headMesh', 'leftEyeGroup', 'rightEyeGroup', 'mouthGroup', 'mouthCavity', 'upperLip', 'lowerLip', 'teethUpper', 'teethLower', 'baseMouth']) {
      assert.ok(group.userData[key], `${char.id} must expose userData.${key}`);
    }
    assert.equal(group.userData.characterId, char.id, `${char.id} must tag its characterId`);
    assert.ok(group.userData.leftEyeGroup.position.x === -group.userData.rightEyeGroup.position.x, `${char.id} eyes must be symmetric (forward-facing)`);
    assert.ok(group.userData.mouthCavity.position.z < group.userData.upperLip.position.z, `${char.id} mouth cavity must sit behind the lips`);
    assert.ok(group.morphTargetDictionary.jawOpen !== undefined, `${char.id} must keep the jawOpen contract`);
  }
});

function buildRecordingMockTHREE(log) {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }
  function posAttr(n) {
    const array = new Float32Array(n * 3);
    return {
      count: n, array,
      getX(i) { return array[i * 3]; },
      getY(i) { return array[i * 3 + 1]; },
      getZ(i) { return array[i * 3 + 2]; },
      setX(i, v) { array[i * 3] = v; },
      setY(i, v) { array[i * 3 + 1] = v; },
      setZ(i, v) { array[i * 3 + 2] = v; }
    };
  }
  class RecGeometry {
    constructor(type, args) {
      this.geoType = type; this.geoArgs = args;
      this.attributes = { position: posAttr(24) }; this.morphAttributes = {};
      log.geometries.push({ type, args: [...args] });
    }
    scale(x, y, z) { log.scales.push({ type: this.geoType, x, y, z }); }
    computeVertexNormals() { log.normalsRecomputed = (log.normalsRecomputed || 0) + 1; }
  }
  const geo = (t) => class extends RecGeometry { constructor(...a) { super(t, a); } };
  class RecMaterial {
    constructor(type, opts) { this.matType = type; this.opts = opts || {}; log.materials.push({ type, opts: this.opts }); }
  }
  const mat = (t) => class extends RecMaterial { constructor(o) { super(t, o); } };
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material;
      this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1);
    }
  }
  class Group {
    constructor() {
      this.children = []; this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1);
    }
    add(...children) { this.children.push(...children); }
    traverse(fn) { fn(this); for (const ch of this.children) { fn(ch); if (ch.children) for (const g of ch.children) fn(g); } }
  }
  class Color { constructor(val) { this.val = val; } }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  return {
    Group,
    SphereGeometry: geo('Sphere'), BoxGeometry: geo('Box'), CylinderGeometry: geo('Cylinder'),
    ConeGeometry: geo('Cone'), TorusGeometry: geo('Torus'), IcosahedronGeometry: geo('Icosahedron'),
    BufferAttribute,
    MeshStandardMaterial: mat('Standard'), MeshToonMaterial: mat('Toon'),
    MeshPhongMaterial: mat('Phong'), MeshBasicMaterial: mat('Basic'),
    Mesh, Color
  };
}

function buildSyntheticSpherePositions() {
  // Small synthetic sphere: rings at several heights (jaw → brow → top).
  const pts = [];
  const rings = [
    { y: -0.42, r: 0.22 }, { y: -0.2, r: 0.42 }, { y: 0.0, r: 0.48 },
    { y: 0.27, r: 0.40 }, { y: 0.45, r: 0.20 }
  ];
  for (const ring of rings) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pts.push([Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r]);
    }
  }
  return pts;
}

function fakeHeadGeo(pts) {
  const n = pts.length;
  const array = new Float32Array(n * 3);
  pts.forEach((p, i) => { array[i * 3] = p[0]; array[i * 3 + 1] = p[1]; array[i * 3 + 2] = p[2]; });
  let normals = 0;
  return {
    attributes: { position: { count: n, array } },
    computeVertexNormals() { normals++; },
    __normals: () => normals
  };
}

test('HeadSculpt: narrows jaws, extends chins, preserves count/order/symmetry per character', async () => {
  const { sculptHeadGeometry, HEAD_SCULPT } = await import('../src/avatar-face-replacement/avatar-model-generator.js');

  assert.ok(Object.keys(HEAD_SCULPT).length >= 15, 'Every character needs sculpt parameters');

  const before = buildSyntheticSpherePositions();
  const geo = fakeHeadGeo(before.map(p => [...p]));
  assert.equal(sculptHeadGeometry(geo, 'toon-girl'), true, 'Sculpt must apply to real arrays');
  const after = geo.attributes.position.array;
  assert.equal(after.length, before.length * 3, 'Vertex count and order must be preserved');

  // Jaw ring (y=-0.2, r=0.42) must narrow for heart-shaped toon-girl.
  let jawBefore = 0, jawAfter = 0;
  for (let i = 8; i < 16; i++) {
    jawBefore += Math.abs(before[i][0]);
    jawAfter += Math.abs(after[i * 3]);
  }
  assert.ok(jawAfter < jawBefore, 'Jaw ring must narrow after sculpt');

  // Bottom ring (y=-0.42) chin front (z>0) must extend downward.
  let chinBefore = before[0][1], chinAfter = after[7];
  assert.ok(chinAfter <= chinBefore, 'Chin must extend or hold, never retract');
  assert.ok(geo.__normals() > 0, 'Normals must be recomputed after displacement');

  // Bilateral symmetry preserved (ring y=0 lives at indices 16..23;
  // mirror of angle k/8*2PI is (8-k)%8).
  for (const [a, b] of [[1, 7], [2, 6], [3, 5]]) {
    const ia = (16 + a) * 3;
    const ib = (16 + b) * 3;
    assert.ok(Math.abs(Math.abs(after[ia]) - Math.abs(after[ib])) < 1e-6, 'Sculpt must stay left/right symmetric');
    assert.ok(Math.abs(after[ia + 1] - after[ib + 1]) < 1e-9, 'Sculpt must keep mirrored heights equal');
  }

  // Different characters sculpt differently (square-jaw keeps more jaw than heart face).
  const gSquare = fakeHeadGeo(buildSyntheticSpherePositions());
  const gHeart = fakeHeadGeo(buildSyntheticSpherePositions());
  sculptHeadGeometry(gSquare, 'adult-man');
  sculptHeadGeometry(gHeart, 'toon-girl');
  let sqJaw = 0, heJaw = 0;
  for (let i = 8; i < 16; i++) {
    sqJaw += Math.abs(gSquare.attributes.position.array[i * 3]);
    heJaw += Math.abs(gHeart.attributes.position.array[i * 3]);
  }
  assert.ok(sqJaw > heJaw, 'Square-jawva must retain a wider jaw than the heart-shaped face');

  // Safety: unknown ids fall back, mock geometries without arrays skip.
  assert.equal(sculptHeadGeometry(fakeHeadGeo([[0, 0, 0.5]]), 'nope'), true, 'Unknown ids must use neutral sculpt');
  assert.equal(sculptHeadGeometry({ attributes: { position: { count: 3 } } }, 'toon-boy'), false, 'Array-less mocks must skip safely');
});

test('Default characters: recording mocks prove genuinely distinct designs (palette, silhouette, variety)', async () => {
  const { createProcedural3DToonAvatar, AVATAR_CHARACTER_LIST } = await import('../src/avatar-face-replacement/avatar-model-generator.js');

  const signatures = [];
  for (const char of AVATAR_CHARACTER_LIST) {
    const log = { geometries: [], materials: [], scales: [] };
    const group = createProcedural3DToonAvatar(buildRecordingMockTHREE(log), char.id);
    const colors = [...new Set(log.materials.map(m => m.opts && m.opts.color).filter(v => v !== undefined))].sort((a, b) => a - b);
    const geoTypes = [...new Set(log.geometries.map(g => g.type))].sort().join('+');
    const headGeo = log.geometries[0];
    const headScale = log.scales.find(s => s.type === headGeo.type) || null;
    const headSig = JSON.stringify([headGeo.type, headGeo.args.slice(0, 3), headScale && [headScale.x, headScale.y, headScale.z]]);
    const skin = (log.materials.find(m => m.type === 'Standard' && !m.opts.metalness) || { opts: {} }).opts.color;
    signatures.push({ id: char.id, colors, geoTypes, headSig, skin, kids: group.children.length });
  }

  // 15 pairwise-distinct combined design signatures (palette + silhouette + build).
  const sigStrings = signatures.map(s => JSON.stringify([s.headSig, s.skin, s.colors, s.geoTypes]));
  assert.equal(new Set(sigStrings).size, 15, 'All 15 designs must be pairwise distinct');

  // Palette breadth (catches recolor-clone regressions).
  assert.ok(new Set(signatures.map(s => s.skin)).size >= 12, 'Skin palettes must span at least 12 distinct tones');
  const hairColors = signatures.map(s => s.colors);
  assert.ok(new Set(hairColors.map(c => JSON.stringify(c))).size >= 10, 'Overall color stories must vary across characters');

  // Silhouette breadth (catches geometry-clone regressions).
  assert.ok(new Set(signatures.map(s => s.headSig)).size >= 10, 'Head silhouettes must span at least 10 distinct shapes');

  // Build variety: accessory-rich vs minimal characters must differ in mass.
  const kidCounts = signatures.map(s => s.kids);
  assert.ok(Math.max(...kidCounts) - Math.min(...kidCounts) >= 3, 'Characters must vary in accessory mass, not just color');
});

test('Renderer light rig: hemisphere fill present, ambient restrained, key light unchanged', async () => {
  const { AvatarFaceRenderer } = await import('../src/avatar-face-replacement/avatar-renderer.js');

  const added = [];
  const MockTHREE = {
    Scene: class { constructor() { this.children = []; } add(c) { this.children.push(c); } },
    PerspectiveCamera: class { constructor() { this.position = { set() {} }; } },
    WebGLRenderer: class {
      constructor() {}
      setSize() {}
      setPixelRatio() {}
      setClearColor() {}
      render() {}
    },
    AmbientLight: class { constructor(color, intensity) { this.kind = 'ambient'; this.color = color; this.intensity = intensity; added.push(this); } },
    HemisphereLight: class {
      constructor(sky, ground, intensity) { this.kind = 'hemi'; this.sky = sky; this.ground = ground; this.intensity = intensity; added.push(this); }
    },
    DirectionalLight: class {
      constructor(color, intensity) { this.kind = 'dir'; this.color = color; this.intensity = intensity; this.position = { set() {} }; added.push(this); }
    }
  };

  const renderer = new AvatarFaceRenderer(null, MockTHREE);
  renderer.initScene(1280, 720);

  const ambient = added.find(l => l.kind === 'ambient');
  const hemi = added.find(l => l.kind === 'hemi');
  const dirs = added.filter(l => l.kind === 'dir');
  assert.ok(ambient && ambient.intensity <= 1.0, 'Ambient must be restrained so sculpt keeps modeling');
  assert.ok(hemi && hemi.intensity > 0 && hemi.intensity <= 0.8, 'Hemisphere fill must exist for well-lit faces');
  assert.ok(dirs.some(d => d.intensity === 1.6), 'Key light must stay at full strength');
  const total = added.reduce((sum, l) => sum + (l.intensity || 0), 0);
  assert.ok(total >= 3.0 && total <= 4.5, `Total light energy must stay near the original 3.9 (got ${total})`);
});

const PILOT_SPEC_TARGETS = [
  'jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFunnel', 'mouthPucker', 'browInnerUp'
];

function parsePilotGLB(id) {
  const rel = `src/public/avatar-assets/${id}/${id}.glb`;
  const buf = fs.readFileSync(rel);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const jsonLen = dv.getUint32(12, true);
  const jsonType = dv.getUint32(16, true);
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8').replace(/\s+$/, ''));
  const binLen = dv.getUint32(20 + jsonLen, true);
  const binType = dv.getUint32(20 + jsonLen + 4, true);
  const bin = buf.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
  return { buf, magic, version, jsonType, binType, json, bin };
}

function readPilotAcc(json, bin, idx, channels) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const Arr = acc.componentType === 5123 ? Uint16Array : Float32Array;
  return new Arr(bin.buffer, bin.byteOffset + bv.byteOffset, acc.count * channels);
}

function findPilotMesh(json, name) {
  const mi = json.meshes.findIndex((m, i) => json.nodes.some(n => n.mesh === i && n.name === name));
  assert.ok(mi >= 0, `Mesh node ${name} must exist`);
  return json.meshes[mi];
}

test('Pilot GLBs: valid container, spec morph sets, symmetric modeled heads', async () => {
  for (const id of ['toon-boy', 'adult-woman']) {
    const size = fs.statSync(`src/public/avatar-assets/${id}/${id}.glb`).size;
    assert.ok(size < 1536 * 1024, `${id} GLB must stay under budget (got ${(size / 1024).toFixed(1)}KB)`);
    const mirror = fs.statSync(`public/avatar-assets/${id}/${id}.glb`).size;
    assert.equal(mirror, size, `${id} public mirror must match src/public bytes`);

    const g = parsePilotGLB(id);
    assert.equal(g.magic, 0x46546C67, `${id} GLB magic must be glTF`);
    assert.equal(g.version, 2, `${id} must be glTF 2.0`);
    assert.equal(g.jsonType, 0x4E4F534A, `${id} must carry a JSON chunk`);
    assert.equal(g.binType, 0x004E4942, `${id} must carry a BIN chunk`);
    assert.ok(g.json.nodes.length > 5 && g.json.materials.length >= 10, `${id} must contain a real cast and palette`);
    assert.ok(!g.json.nodes[0].matrix && g.json.nodes[0].name === 'AvatarRoot', `${id} root must be identity`);

    const head = findPilotMesh(g.json, 'Head');
    assert.equal(head.primitives.length, 3, `${id} head must split skin/lips/cavity`);
    for (const [pi, p] of head.primitives.entries()) {
      assert.deepEqual((p.extras || {}).targetNames, PILOT_SPEC_TARGETS, `${id} head prim${pi} must declare the 8 spec morphs`);
      const base = readPilotAcc(g.json, g.bin, p.attributes.POSITION, 3);
      for (const t of p.targets) {
        assert.equal(readPilotAcc(g.json, g.bin, t.POSITION, 3).length, base.length, `${id} prim${pi} target arrays must match vertex count`);
      }
    }

    // Base symmetry on the skin primitive (full search, tight tolerance).
    const sp = readPilotAcc(g.json, g.bin, head.primitives[0].attributes.POSITION, 3);
    const sn = sp.length / 3;
    let bad = 0, tot = 0, zeroN = 0;
    const sN = readPilotAcc(g.json, g.bin, head.primitives[0].attributes.NORMAL, 3);
    for (let i = 0; i < sn; i++) {
      if (sN[i * 3] === 0 && sN[i * 3 + 1] === 0 && sN[i * 3 + 2] === 0) zeroN++;
      const x = sp[i * 3], y = sp[i * 3 + 1], z = sp[i * 3 + 2];
      if (Math.abs(x) < 0.02) continue;
      tot++;
      let found = false;
      for (let j = 0; j < sn; j++) {
        if (Math.abs(sp[j * 3] + x) < 0.004 && Math.abs(sp[j * 3 + 1] - y) < 0.004 && Math.abs(sp[j * 3 + 2] - z) < 0.004) { found = true; break; }
      }
      if (!found) bad++;
    }
    assert.equal(zeroN, 0, `${id} must have no zero normals`);
    assert.equal(bad, 0, `${id} base head must be bilaterally symmetric (${bad}/${tot} unmatched)`);
  }
});

test('Pilot GLBs: morph simulation proves visible jaw, blink, smile, funnel, pucker, brow', async () => {
  for (const id of ['toon-boy', 'adult-woman']) {
    const g = parsePilotGLB(id);
    const head = findPilotMesh(g.json, 'Head');
    const prim = head.primitives[0];
    const sp = readPilotAcc(g.json, g.bin, prim.attributes.POSITION, 3);
    const n = sp.length / 3;
    const sim = (ti) => readPilotAcc(g.json, g.bin, prim.targets[ti].POSITION, 3);

    let chinDrop = 0;
    {
      const t = sim(0);
      for (let i = 0; i < n; i++) {
        if (sp[i * 3 + 1] < -0.15 && sp[i * 3 + 2] > 0.1) chinDrop = Math.min(chinDrop, t[i * 3 + 1]);
      }
    }
    assert.ok(chinDrop <= -0.10, `${id} jawOpen must visibly drop the chin (got ${chinDrop.toFixed(3)})`);

    for (const [ti, side, nm] of [[1, -1, 'eyeBlinkLeft'], [2, 1, 'eyeBlinkRight']]) {
      const t = sim(ti);
      let drop = 0, cross = 0;
      for (let i = 0; i < n; i++) {
        const x = sp[i * 3], y = sp[i * 3 + 1];
        if (Math.abs(Math.abs(x) - 0.18) < 0.12 && y > 0.02 && y < 0.30 && sp[i * 3 + 2] > 0.30) {
          drop = Math.min(drop, t[i * 3 + 1]);
          if (Math.sign(x) !== side && t[i * 3 + 1] < -0.01) cross++;
        }
      }
      assert.ok(drop <= -0.05 && cross === 0, `${id} ${nm} must drop its own lids only`);
    }

    for (const [ti, side, nm] of [[3, -1, 'mouthSmileLeft'], [4, 1, 'mouthSmileRight']]) {
      const t = sim(ti);
      let lift = 0;
      for (let i = 0; i < n; i++) {
        const x = sp[i * 3], y = sp[i * 3 + 1];
        if (Math.sign(x) === side && Math.abs(x) > 0.05 && y < 0.08 && y > -0.32 && sp[i * 3 + 2] > 0.18) {
          lift = Math.max(lift, t[i * 3 + 1]);
        }
      }
      assert.ok(lift >= 0.08, `${id} ${nm} must visibly lift its corner`);
    }

    for (const [ti, nm, min] of [[5, 'mouthFunnel', 0.12], [6, 'mouthPucker', 0.15]]) {
      const t = sim(ti);
      let push = 0;
      for (let i = 0; i < n; i++) if (t[i * 3 + 2] > push) push = t[i * 3 + 2];
      assert.ok(push >= min, `${id} ${nm} must protrude (got ${push.toFixed(3)})`);
    }

    {
      const t = sim(7);
      let lift = 0;
      for (let i = 0; i < n; i++) {
        if (Math.abs(sp[i * 3]) < 0.12 && sp[i * 3 + 1] > 0.15 && sp[i * 3 + 2] > 0.25) {
          lift = Math.max(lift, t[i * 3 + 1]);
        }
      }
      assert.ok(lift >= 0.05, `${id} browInnerUp must visibly lift`);
    }
  }
});

test('Pilot integration: registry maps GLBs, loader prefers them, fallback stays procedural', async () => {
  const { AvatarAssetLoader, AVATAR_CHARACTER_LIST, PILOT_CHARACTER_GLB } = await import('../src/avatar-face-replacement/avatar-asset-loader.js');

  assert.equal(AVATAR_CHARACTER_LIST.length, 15, 'Gallery must still list exactly 15');
  assert.ok(PILOT_CHARACTER_GLB['toon-boy'].endsWith('toon-boy.glb'), 'toon-boy must map to its pilot GLB');
  assert.ok(PILOT_CHARACTER_GLB['adult-woman'].endsWith('adult-woman.glb'), 'adult-woman must map to its pilot GLB');
  assert.equal(Object.keys(PILOT_CHARACTER_GLB).length, 2, 'Only the two approved pilots may map (no P2 scope creep)');

  // Corrupt/unreachable GLB must fall back to the procedural builder, tagged correctly.
  class Vector3 { set() {} }
  class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } }
  class BufferGeometry {
    constructor() { this.attributes = { position: new BufferAttribute(new Float32Array(32 * 3), 3) }; this.morphAttributes = {}; }
    scale() {}
  }
  class SphereGeometry extends BufferGeometry {}
  class CylinderGeometry extends BufferGeometry {}
  class ConeGeometry extends BufferGeometry {}
  class BoxGeometry extends BufferGeometry {}
  class TorusGeometry extends BufferGeometry {}
  class MeshToonMaterial {}
  class MeshPhongMaterial {}
  class MeshBasicMaterial {}
  class MeshStandardMaterial {}
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
  }
  class Group {
    constructor() { this.children = []; this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(); }
    add(child) { this.children.push(child); }
  }
  const MockTHREE = {
    Group, SphereGeometry, CylinderGeometry, ConeGeometry, BoxGeometry, TorusGeometry,
    BufferAttribute, MeshToonMaterial, MeshPhongMaterial, MeshBasicMaterial, MeshStandardMaterial, Mesh
  };
  class FailingGLTFLoader {
    load(url, onLoad, onProgress, onError) {
      assert.ok(String(url).endsWith('.glb'), 'Loader must request the mapped GLB url');
      onError(new Error('simulated missing asset'));
    }
  }
  const loader = new AvatarAssetLoader(MockTHREE, FailingGLTFLoader);
  const group = await loader.loadCharacterAsset('toon-boy');
  assert.ok(group, 'Fallback must still produce a character when the GLB is unreachable');
  assert.equal(group.userData.characterId, 'toon-boy', 'Fallback must keep the requested character id');
  assert.ok(group.userData.headMesh, 'Fallback must be the procedural contract model');
});


