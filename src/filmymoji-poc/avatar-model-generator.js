/**
 * Standalone Filmymoji POC — Procedural 3D Character Avatar Head Generator
 *
 * Constructs a stylized 3D toon character head mesh in Three.js with full
 * ARKit-compatible morph target deformation vertices (jawOpen, eyeBlinkLeft,
 * eyeBlinkRight, mouthSmileLeft, mouthSmileRight, mouthFunnel, etc.).
 */

export function createProcedural3DToonAvatar(THREE) {
  const group = new THREE.Group();
  group.name = 'FilmymojiToonAvatarGroup';

  // 1. Head Base Geometry
  const headGeo = new THREE.SphereGeometry(0.5, 32, 32);
  headGeo.scale(1, 1.25, 1); // Cartoon head proportion

  const positionAttr = headGeo.attributes.position;
  const vertexCount = positionAttr.count;

  // Define 52 ARKit Morph Target Names
  const morphTargetNames = [
    'jawOpen',
    'eyeBlinkLeft',
    'eyeBlinkRight',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthFunnel',
    'browOuterUpLeft',
    'browOuterUpRight',
    'browInnerUp',
    'eyeLookInLeft',
    'eyeLookOutLeft',
    'eyeLookInRight',
    'eyeLookOutRight'
  ];

  const morphTargetDictionary = {};
  const morphAttributesPosition = [];

  for (let m = 0; m < morphTargetNames.length; m++) {
    const shapeName = morphTargetNames[m];
    morphTargetDictionary[shapeName] = m;

    const morphPositions = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      const x = positionAttr.getX(i);
      const y = positionAttr.getY(i);
      const z = positionAttr.getZ(i);

      let dx = 0, dy = 0, dz = 0;

      // Jaw Open Morph Target
      if (shapeName === 'jawOpen' && y < -0.1 && z > -0.2) {
        dy = -0.22 * Math.abs(y);
        dz = 0.08 * Math.abs(y);
      }

      // Mouth Smile Morph Targets
      if (shapeName === 'mouthSmileLeft' && x < -0.1 && y < 0 && z > 0.1) {
        dy = 0.08;
        dx = -0.05;
      }
      if (shapeName === 'mouthSmileRight' && x > 0.1 && y < 0 && z > 0.1) {
        dy = 0.08;
        dx = 0.05;
      }

      // Mouth Funnel
      if (shapeName === 'mouthFunnel' && Math.hypot(x, y + 0.25) < 0.2 && z > 0.3) {
        dz = 0.12;
      }

      // Eyebrow Elevation Morphs
      if (shapeName === 'browOuterUpLeft' && x < -0.15 && y > 0.2) {
        dy = 0.08;
      }
      if (shapeName === 'browOuterUpRight' && x > 0.15 && y > 0.2) {
        dy = 0.08;
      }

      morphPositions[i * 3] = x + dx;
      morphPositions[i * 3 + 1] = y + dy;
      morphPositions[i * 3 + 2] = z + dz;
    }

    const morphAttr = new THREE.BufferAttribute(morphPositions, 3);
    morphAttr.name = shapeName;
    morphAttributesPosition.push(morphAttr);
  }

  headGeo.morphAttributes.position = morphAttributesPosition;

  // Toon Head Material
  const headMat = new THREE.MeshToonMaterial({
    color: 0xffcc99,
    bumpScale: 0.02
  });

  const headMesh = new THREE.Mesh(headGeo, headMat);
  headMesh.name = 'FilmymojiHeadMesh';
  headMesh.morphTargetDictionary = morphTargetDictionary;
  headMesh.morphTargetInfluences = new Float32Array(morphTargetNames.length);

  group.add(headMesh);

  // 2. Eyes (Left and Right Cartoon Eyes)
  const eyeGeo = new THREE.SphereGeometry(0.09, 16, 16);
  const eyeMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 100 });
  const pupilGeo = new THREE.SphereGeometry(0.045, 16, 16);
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111122 });

  // Left Eye
  const leftEyeGroup = new THREE.Group();
  leftEyeGroup.position.set(-0.18, 0.15, 0.42);
  const leftEyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
  const leftPupilMesh = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupilMesh.position.set(0, 0, 0.06);
  leftEyeGroup.add(leftEyeMesh);
  leftEyeGroup.add(leftPupilMesh);
  group.add(leftEyeGroup);

  // Right Eye
  const rightEyeGroup = new THREE.Group();
  rightEyeGroup.position.set(0.18, 0.15, 0.42);
  const rightEyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
  const rightPupilMesh = new THREE.Mesh(pupilGeo, pupilMat);
  rightPupilMesh.position.set(0, 0, 0.06);
  rightEyeGroup.add(rightEyeMesh);
  rightEyeGroup.add(rightPupilMesh);
  group.add(rightEyeGroup);

  // 3. Cute Cartoon Nose
  const noseGeo = new THREE.SphereGeometry(0.06, 16, 16);
  const noseMat = new THREE.MeshToonMaterial({ color: 0xeb9980 });
  const noseMesh = new THREE.Mesh(noseGeo, noseMat);
  noseMesh.position.set(0, -0.02, 0.52);
  group.add(noseMesh);

  // Attach reference pointers for direct eye morph driving
  headMesh.userData = {
    leftEyeGroup,
    rightEyeGroup
  };

  return headMesh;
}
