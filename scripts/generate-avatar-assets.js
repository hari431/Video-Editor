/**
 * Generate 3D Character Assets for Avatar Face Replacement
 *
 * Produces binary GLB 3D character asset (character-01/character.glb)
 * and rich preview asset (character-01/preview.svg) conforming to the
 * common ARKit-compatible facial animation contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDirs = [
  path.resolve(__dirname, '../public/avatar-assets/character-01'),
  path.resolve(__dirname, '../src/public/avatar-assets/character-01')
];

outputDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Construct GLB Binary Buffer for stylized 3D toon character "Bobblehead Boy"
function createCharacter01GLB() {
  // Vertices for stylized toon head (box/sphere geometry)
  const basePositions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Generate sphere-like head vertices (stacks x slices)
  const stacks = 16;
  const slices = 24;
  const radius = 0.5;

  for (let stack = 0; stack <= stacks; stack++) {
    const phi = (stack * Math.PI) / stacks;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let slice = 0; slice <= slices; slice++) {
      const theta = (slice * 2 * Math.PI) / slices;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      // Stylized slightly squished toon head shape
      const x = radius * 0.95 * sinPhi * cosTheta;
      const y = radius * 1.15 * cosPhi;
      const z = radius * 0.95 * sinPhi * sinTheta;

      basePositions.push(x, y, z);

      const nx = sinPhi * cosTheta;
      const ny = cosPhi;
      const nz = sinPhi * sinTheta;
      normals.push(nx, ny, nz);

      uvs.push(slice / slices, stack / stacks);
    }
  }

  // Create indices
  for (let stack = 0; stack < stacks; stack++) {
    for (let slice = 0; slice < slices; slice++) {
      const first = stack * (slices + 1) + slice;
      const second = first + slices + 1;

      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  // Define Morph Target deltas for ARKit contract
  const numVertices = basePositions.length / 3;

  // 1. jawOpen morph target: pulls lower mouth vertices down
  const jawOpenDeltas = new Float32Array(numVertices * 3);
  // 2. eyeBlinkLeft morph target: lowers upper left eye vertices
  const eyeBlinkLeftDeltas = new Float32Array(numVertices * 3);
  // 3. eyeBlinkRight morph target: lowers upper right eye vertices
  const eyeBlinkRightDeltas = new Float32Array(numVertices * 3);
  // 4. mouthSmileLeft morph target: pulls left mouth corner up & back
  const mouthSmileLeftDeltas = new Float32Array(numVertices * 3);
  // 5. mouthSmileRight morph target: pulls right mouth corner up & back
  const mouthSmileRightDeltas = new Float32Array(numVertices * 3);
  // 6. mouthFunnel morph target: narrows mouth width
  const mouthFunnelDeltas = new Float32Array(numVertices * 3);
  // 7. mouthPucker morph target: extends lips forward
  const mouthPuckerDeltas = new Float32Array(numVertices * 3);
  // 8. browInnerUp morph target: raises inner brow region
  const browInnerUpDeltas = new Float32Array(numVertices * 3);

  for (let i = 0; i < numVertices; i++) {
    const x = basePositions[i * 3];
    const y = basePositions[i * 3 + 1];
    const z = basePositions[i * 3 + 2];

    // Jaw area (y < -0.1 and z > 0)
    if (y < -0.1 && z > 0.1) {
      const influence = Math.min(1.0, Math.abs(y + 0.1) * 2.5);
      jawOpenDeltas[i * 3 + 1] = -0.22 * influence; // Y displacement
      jawOpenDeltas[i * 3 + 2] = 0.05 * influence;  // Z displacement
    }

    // Left Eye Area (x < -0.1, y > 0.05, z > 0.2)
    if (x < -0.1 && x > -0.35 && y > 0.05 && y < 0.25 && z > 0.2) {
      eyeBlinkLeftDeltas[i * 3 + 1] = -0.12;
    }

    // Right Eye Area (x > 0.1, x < 0.35, y > 0.05, y < 0.25 && z > 0.2)
    if (x > 0.1 && x < 0.35 && y > 0.05 && y < 0.25 && z > 0.2) {
      eyeBlinkRightDeltas[i * 3 + 1] = -0.12;
    }

    // Smile Left (x < -0.1, y < 0, z > 0.25)
    if (x < -0.1 && y < 0 && z > 0.25) {
      mouthSmileLeftDeltas[i * 3 + 1] = 0.08;
      mouthSmileLeftDeltas[i * 3] = -0.05;
    }

    // Smile Right (x > 0.1, y < 0, z > 0.25)
    if (x > 0.1 && y < 0 && z > 0.25) {
      mouthSmileRightDeltas[i * 3 + 1] = 0.08;
      mouthSmileRightDeltas[i * 3] = 0.05;
    }

    // Mouth Funnel
    if (Math.abs(x) < 0.2 && y < 0 && z > 0.25) {
      mouthFunnelDeltas[i * 3] = -x * 0.4;
      mouthFunnelDeltas[i * 3 + 2] = 0.08;
    }

    // Mouth Pucker
    if (Math.abs(x) < 0.2 && y < 0 && z > 0.25) {
      mouthPuckerDeltas[i * 3 + 2] = 0.12;
    }

    // Brow Inner Up
    if (Math.abs(x) < 0.25 && y > 0.22 && z > 0.2) {
      browInnerUpDeltas[i * 3 + 1] = 0.08;
    }
  }

  // Package into ArrayBuffers
  const posBuf = Buffer.from(new Float32Array(basePositions).buffer);
  const normBuf = Buffer.from(new Float32Array(normals).buffer);
  const uvBuf = Buffer.from(new Float32Array(uvs).buffer);
  const idxBuf = Buffer.from(new Uint16Array(indices).buffer);

  const jawBuf = Buffer.from(jawOpenDeltas.buffer);
  const blinkLBuf = Buffer.from(eyeBlinkLeftDeltas.buffer);
  const blinkRBuf = Buffer.from(eyeBlinkRightDeltas.buffer);
  const smileLBuf = Buffer.from(mouthSmileLeftDeltas.buffer);
  const smileRBuf = Buffer.from(mouthSmileRightDeltas.buffer);
  const funnelBuf = Buffer.from(mouthFunnelDeltas.buffer);
  const puckerBuf = Buffer.from(mouthPuckerDeltas.buffer);
  const browBuf = Buffer.from(browInnerUpDeltas.buffer);

  // Concatenate all binary chunk data
  const binChunks = [
    posBuf, normBuf, uvBuf, idxBuf,
    jawBuf, blinkLBuf, blinkRBuf, smileLBuf, smileRBuf, funnelBuf, puckerBuf, browBuf
  ];
  const totalBinLen = binChunks.reduce((sum, b) => sum + b.length, 0);
  const binBuffer = Buffer.concat(binChunks, totalBinLen);

  // Helper to calculate byte offsets
  let offset = 0;
  const posOffset = offset; offset += posBuf.length;
  const normOffset = offset; offset += normBuf.length;
  const uvOffset = offset; offset += uvBuf.length;
  const idxOffset = offset; offset += idxBuf.length;
  const jawOffset = offset; offset += jawBuf.length;
  const blinkLOffset = offset; offset += blinkLBuf.length;
  const blinkROffset = offset; offset += blinkRBuf.length;
  const smileLOffset = offset; offset += smileLBuf.length;
  const smileROffset = offset; offset += smileRBuf.length;
  const funnelOffset = offset; offset += funnelBuf.length;
  const puckerOffset = offset; offset += puckerBuf.length;
  const browOffset = offset; offset += browBuf.length;

  // Construct glTF JSON Structure
  const gltfJson = {
    asset: { version: '2.0', generator: 'Filmymoji 3D Character Asset Generator' },
    scene: 0,
    scenes: [{ name: 'ToonCharacterScene', nodes: [0] }],
    nodes: [{ name: 'ToonBobbleheadHead', mesh: 0 }],
    materials: [
      {
        name: 'ToonSkinMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [0.98, 0.78, 0.68, 1.0],
          roughnessFactor: 0.4,
          metallicFactor: 0.0
        }
      }
    ],
    meshes: [
      {
        name: 'CharacterHeadMesh',
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2
            },
            indices: 3,
            material: 0,
            targets: [
              { POSITION: 4 }, // jawOpen
              { POSITION: 5 }, // eyeBlinkLeft
              { POSITION: 6 }, // eyeBlinkRight
              { POSITION: 7 }, // mouthSmileLeft
              { POSITION: 8 }, // mouthSmileRight
              { POSITION: 9 }, // mouthFunnel
              { POSITION: 10 }, // mouthPucker
              { POSITION: 11 }  // browInnerUp
            ]
          }
        ],
        targetNames: [
          'jawOpen',
          'eyeBlinkLeft',
          'eyeBlinkRight',
          'mouthSmileLeft',
          'mouthSmileRight',
          'mouthFunnel',
          'mouthPucker',
          'browInnerUp'
        ]
      }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: numVertices, type: 'VEC3', max: [0.5, 0.6, 0.5], min: [-0.5, -0.6, -0.5] }, // POS
      { bufferView: 1, componentType: 5126, count: numVertices, type: 'VEC3' }, // NORM
      { bufferView: 2, componentType: 5126, count: numVertices, type: 'VEC2' }, // UV
      { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' }, // INDICES
      { bufferView: 4, componentType: 5126, count: numVertices, type: 'VEC3' }, // jawOpen
      { bufferView: 5, componentType: 5126, count: numVertices, type: 'VEC3' }, // eyeBlinkLeft
      { bufferView: 6, componentType: 5126, count: numVertices, type: 'VEC3' }, // eyeBlinkRight
      { bufferView: 7, componentType: 5126, count: numVertices, type: 'VEC3' }, // mouthSmileLeft
      { bufferView: 8, componentType: 5126, count: numVertices, type: 'VEC3' }, // mouthSmileRight
      { bufferView: 9, componentType: 5126, count: numVertices, type: 'VEC3' }, // mouthFunnel
      { bufferView: 10, componentType: 5126, count: numVertices, type: 'VEC3' }, // mouthPucker
      { bufferView: 11, componentType: 5126, count: numVertices, type: 'VEC3' }  // browInnerUp
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: normOffset, byteLength: normBuf.length, target: 34962 },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvBuf.length, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBuf.length, target: 34963 },
      { buffer: 0, byteOffset: jawOffset, byteLength: jawBuf.length },
      { buffer: 0, byteOffset: blinkLOffset, byteLength: blinkLBuf.length },
      { buffer: 0, byteOffset: blinkROffset, byteLength: blinkRBuf.length },
      { buffer: 0, byteOffset: smileLOffset, byteLength: smileLBuf.length },
      { buffer: 0, byteOffset: smileROffset, byteLength: smileRBuf.length },
      { buffer: 0, byteOffset: funnelOffset, byteLength: funnelBuf.length },
      { buffer: 0, byteOffset: puckerOffset, byteLength: puckerBuf.length },
      { buffer: 0, byteOffset: browOffset, byteLength: browBuf.length }
    ],
    buffers: [{ byteLength: totalBinLen }]
  };

  // Convert JSON to Buffer padded to 4-byte boundary
  let jsonString = JSON.stringify(gltfJson);
  while (jsonString.length % 4 !== 0) {
    jsonString += ' ';
  }
  const jsonBuf = Buffer.from(jsonString, 'utf8');

  // Build 12-byte GLB Header + Chunks
  const headerLen = 12;
  const chunk0HeaderLen = 8;
  const chunk1HeaderLen = 8;
  const totalGlbLen = headerLen + chunk0HeaderLen + jsonBuf.length + chunk1HeaderLen + binBuffer.length;

  const glbBuffer = Buffer.alloc(totalGlbLen);

  // GLB Header
  glbBuffer.writeUInt32LE(0x46543167, 0); // Magic: 'glTF'
  glbBuffer.writeUInt32LE(2, 4);          // Version 2
  glbBuffer.writeUInt32LE(totalGlbLen, 8);

  // Chunk 0: JSON
  glbBuffer.writeUInt32LE(jsonBuf.length, 12);
  glbBuffer.writeUInt32LE(0x4E4F534A, 16); // 'JSON'
  jsonBuf.copy(glbBuffer, 20);

  // Chunk 1: BIN
  const chunk1Start = 20 + jsonBuf.length;
  glbBuffer.writeUInt32LE(binBuffer.length, chunk1Start);
  glbBuffer.writeUInt32LE(0x004E4942, chunk1Start + 4); // 'BIN\0'
  binBuffer.copy(glbBuffer, chunk1Start + 8);

  return glbBuffer;
}

// Generate stylized SVG Preview image for Character 01 ("Toon Bobblehead Boy")
function createCharacter01PreviewSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#0369a1"/>
    </linearGradient>
    <linearGradient id="skin" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fde047"/>
      <stop offset="100%" stop-color="#eab308"/>
    </linearGradient>
    <linearGradient id="hair" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>

  <!-- Background Circle -->
  <rect width="200" height="200" rx="20" fill="url(#bg)"/>

  <!-- Character Shirt -->
  <path d="M 50 170 Q 100 135 150 170 L 160 200 L 40 200 Z" fill="#38bdf8"/>

  <!-- Character Neck -->
  <rect x="88" y="125" width="24" height="25" rx="6" fill="#fbcfe8"/>

  <!-- Toon Character Head -->
  <ellipse cx="100" cy="85" rx="52" ry="58" fill="#fed7aa" stroke="#fb923c" stroke-width="2"/>

  <!-- Expressive Toon Eyes -->
  <ellipse cx="80" cy="80" rx="14" ry="18" fill="#ffffff"/>
  <ellipse cx="120" cy="80" rx="14" ry="18" fill="#ffffff"/>

  <!-- Pupils -->
  <ellipse cx="82" cy="82" rx="7" ry="9" fill="#0f172a"/>
  <ellipse cx="122" cy="82" rx="7" ry="9" fill="#0f172a"/>
  <circle cx="84" cy="78" r="2.5" fill="#ffffff"/>
  <circle cx="124" cy="78" r="2.5" fill="#ffffff"/>

  <!-- Cheeks -->
  <circle cx="68" cy="100" r="8" fill="#f43f5e" opacity="0.35"/>
  <circle cx="132" cy="100" r="8" fill="#f43f5e" opacity="0.35"/>

  <!-- Toon Nose -->
  <ellipse cx="100" cy="94" rx="5" ry="4" fill="#f97316"/>

  <!-- Smiling Mouth -->
  <path d="M 82 108 Q 100 128 118 108 Z" fill="#991b1b" stroke="#7f1d1d" stroke-width="1.5"/>
  <path d="M 88 108 Q 100 115 112 108" fill="#ffffff"/>

  <!-- Toon Hair / Cap -->
  <path d="M 46 80 Q 50 25 100 25 Q 150 25 154 80 Q 130 55 100 60 Q 70 55 46 80 Z" fill="#2563eb"/>

  <!-- Toon Eyebrows -->
  <path d="M 68 62 Q 80 56 90 64" fill="none" stroke="#1e3a8a" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M 110 64 Q 120 56 132 62" fill="none" stroke="#1e3a8a" stroke-width="3.5" stroke-linecap="round"/>
</svg>`;
}

// Generate Assets
const glbBuf = createCharacter01GLB();
const svgContent = createCharacter01PreviewSVG();

outputDirs.forEach(dir => {
  fs.writeFileSync(path.join(dir, 'character.glb'), glbBuf);
  console.log(`Saved GLB character asset to ${path.join(dir, 'character.glb')} (${glbBuf.length} bytes)`);
  fs.writeFileSync(path.join(dir, 'preview.svg'), svgContent, 'utf8');
  console.log(`Saved character preview SVG to ${path.join(dir, 'preview.svg')}`);
});
