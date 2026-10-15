/**
 * P1 pilot avatar authoring — clean-room parametric base family (toon-boy,
 * adult-woman) with baked ARKit-compatible morph targets, written as
 * dependency-free GLB 2.0 files. No third-party meshes, no SDKs, no network.
 *
 * Usage: node scripts/generate-pilot-avatars.js
 * Output: src/public/avatar-assets/<id>/<id>.glb (+ public/ mirror)
 *
 * Construction (per docs/avatar-asset-spec.md):
 *  - Head: 60x46 parametric grid with modeled sockets, lids, brow band,
 *    nose bridge+tip, philtrum, lip volumes, cavity recess, jaw/chin/cheeks.
 *  - Primitives per head mesh: skin / lips / cavity (+upper teeth static,
 *    lower teeth + tongue with jawOpen, brows with browInnerUp).
 *  - Eyes (sclera/iris/pupil/catchlight), ears, neck, trapezius, collar,
 *    per-pilot hair shells + strand volumes, woman's gold hoops.
 *  - 8 morph targets with the exact spec names/effects from the asset spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIRS = [
  path.resolve(__dirname, '../src/public/avatar-assets'),
  path.resolve(__dirname, '../public/avatar-assets')
];

const SPEC_TARGETS = [
  'jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFunnel', 'mouthPucker', 'browInnerUp'
];

// ---------------------------------------------------------------- helpers

function srgbToLinear(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map(o => parseInt(h.slice(o, o + 2), 16) / 255);
  return c.map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}

function hexMat(hex, roughness = 0.55, extra = {}) {
  return {
    pbrMetallicRoughness: {
      baseColorFactor: [...srgbToLinear(hex), 1.0],
      metallicFactor: 0.0,
      roughnessFactor: roughness
    },
    ...extra
  };
}

// Parametric UV sphere grid. phiMax < PI yields an open shell (hair caps).
function sphereGrid(nu, nv, r, center = [0, 0, 0], scale = [1, 1, 1], phiMax = Math.PI) {
  const positions = [];
  const indices = [];
  for (let iy = 0; iy <= nv; iy++) {
    const phi = (iy / nv) * phiMax;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let ix = 0; ix <= nu; ix++) {
      const theta = (ix / nu) * Math.PI * 2;
      positions.push(
        center[0] + r * scale[0] * sp * Math.cos(theta),
        center[1] + r * scale[1] * cp,
        center[2] + r * scale[2] * sp * Math.sin(theta)
      );
    }
  }
  for (let iy = 0; iy < nv; iy++) {
    for (let ix = 0; ix < nu; ix++) {
      const a = iy * (nu + 1) + ix;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

function torusMesh(R, r, arc = Math.PI * 2, radialSeg = 12, tubularSeg = 24) {
  const positions = [];
  const indices = [];
  for (let j = 0; j <= radialSeg; j++) {
    const v = (j / radialSeg) * Math.PI * 2;
    for (let i = 0; i <= tubularSeg; i++) {
      const u = (i / tubularSeg) * arc;
      positions.push(
        (R + r * Math.cos(v)) * Math.cos(u),
        (R + r * Math.cos(v)) * Math.sin(u),
        r * Math.sin(v)
      );
    }
  }
  for (let j = 0; j < radialSeg; j++) {
    for (let i = 0; i < tubularSeg; i++) {
      const a = j * (tubularSeg + 1) + i;
      const b = a + tubularSeg + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

function discMesh(r, seg = 20) {
  const positions = [0, 0, 0];
  const indices = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
  }
  for (let i = 1; i <= seg; i++) indices.push(0, i, i + 1 > seg ? 1 : i + 1);
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

function boxMesh(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const positions = new Float32Array([
    -x, -y, z, x, -y, z, x, y, z, -x, y, z,
    -x, -y, -z, -x, y, -z, x, y, -z, x, -y, -z,
    -x, y, -z, -x, y, z, x, y, z, x, y, -z,
    -x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z,
    x, -y, -z, x, y, -z, x, y, z, x, -y, z,
    -x, -y, -z, -x, -y, z, -x, y, z, -x, y, -z
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23
  ]);
  return { positions, indices };
}

function cylinderMesh(rTop, rBottom, h, seg = 20) {
  const positions = [];
  const indices = [];
  positions.push(0, h / 2, 0, 0, -h / 2, 0);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    positions.push(Math.cos(a) * rTop, h / 2, Math.sin(a) * rTop);
    positions.push(Math.cos(a) * rBottom, -h / 2, Math.sin(a) * rBottom);
  }
  for (let i = 0; i < seg; i++) {
    const t0 = 2 + i * 2, b0 = 3 + i * 2, t1 = 4 + i * 2, b1 = 5 + i * 2;
    indices.push(t0, t1, b0, t1, b1, b0); // side (outward)
    indices.push(0, t1, t0); // top cap (+y)
    indices.push(1, b0, b1); // bottom cap (-y)
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

function transformGeo(geo, { translate = [0, 0, 0], scale = [1, 1, 1], rotZ = 0, rotX = 0, rotY = 0 }) {
  const p = geo.positions;
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i] * scale[0], y = p[i + 1] * scale[1], z = p[i + 2] * scale[2];
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx; y = y1; z = z1;
    let x1 = x * cy + z * sy, z2 = -x * sy + z * cy; x = x1; z = z2;
    x1 = x * cz - y * sz; y1 = x * sz + y * cz; x = x1; y = y1;
    p[i] = x + translate[0]; p[i + 1] = y + translate[1]; p[i + 2] = z + translate[2];
  }
  return geo;
}

function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  // Repair pole-seam verts whose only adjacent triangle is degenerate
  // (zero normal): inherit the next vertex's normal.
  const count = normals.length / 3;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < count; i++) {
      if (normals[i * 3] === 0 && normals[i * 3 + 1] === 0 && normals[i * 3 + 2] === 0) {
        const j = ((i + 1) % count) * 3;
        normals[i * 3] = normals[j]; normals[i * 3 + 1] = normals[j + 1]; normals[i * 3 + 2] = normals[j + 2];
      }
    }
  }
  return normals;
}

// ------------------------------------------------------- morph field fns

function morphJaw(x, y, z, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (y < -0.08 && z > 0.05) {
    const inf = Math.min(1.0, Math.abs(y + 0.08) * 2.8);
    out[1] = -0.24 * inf;
    out[2] = 0.06 * inf;
  }
  return out;
}

function morphBlink(x, y, z, eyeX, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  const dx = Math.abs(Math.abs(x) - eyeX);
  if (dx < 0.12 && y > 0.02 && y < 0.30 && z > 0.30) {
    out[1] = -0.08 * (1 - dx / 0.12);
  }
  return out;
}

function morphSmile(x, y, z, side, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (y < 0.08 && y > -0.32 && z > 0.18) {
    if ((side < 0 && x < -0.05) || (side > 0 && x > 0.05)) {
      out[1] = 0.09;
      out[0] = 0.05 * Math.sign(x); // widen outward
    }
  }
  return out;
}

function morphFunnelPucker(x, y, z, mouthY, out, pucker) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  const d = Math.hypot(x, y - mouthY);
  if (d < 0.25 && z > 0.15) {
    out[2] = pucker ? 0.20 : 0.15;
    if (pucker) out[0] = x * -0.3;
  }
  return out;
}

function morphBrow(x, y, z, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (Math.abs(x) < 0.12 && y > 0.15 && y < 0.38 && z > 0.25) {
    out[1] = 0.09;
  }
  return out;
}

function buildTargetsForPositions(positions, eyeX, mouthY) {
  const n = positions.length / 3;
  const tmp = [0, 0, 0];
  const fns = [
    (x, y, z) => morphJaw(x, y, z, tmp),
    (x, y, z) => { morphBlink(x, y, z, eyeX, tmp); if (x > 0) { tmp[0] = 0; tmp[1] = 0; tmp[2] = 0; } },
    (x, y, z) => { morphBlink(x, y, z, eyeX, tmp); if (x < 0) { tmp[0] = 0; tmp[1] = 0; tmp[2] = 0; } },
    (x, y, z) => morphSmile(x, y, z, -1, tmp),
    (x, y, z) => morphSmile(x, y, z, 1, tmp),
    (x, y, z) => morphFunnelPucker(x, y, z, mouthY, tmp, false),
    (x, y, z) => morphFunnelPucker(x, y, z, mouthY, tmp, true),
    (x, y, z) => morphBrow(x, y, z, tmp)
  ];
  return fns.map(fn => {
    const arr = new Float32Array(positions.length);
    for (let i = 0; i < n; i++) {
      fn(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      arr[i * 3] = tmp[0]; arr[i * 3 + 1] = tmp[1]; arr[i * 3 + 2] = tmp[2];
    }
    return arr;
  });
}

// ------------------------------------------------------- head authoring

function gauss(d, s) {
  return Math.exp(-(d * d) / (s * s));
}

function shapeHead(positions, P) {
  // P: {rx,ry,rz, jawT, chinT, cheekT, browT, templeT, skullT,
  //     eyeX, eyeY, sockD, lidT, noseLen, noseW, tipT, mouthY, mouthHW, lipFull, cavD}
  for (let i = 0; i < positions.length; i += 3) {
    // Snap near-zero coords to exact 0 FIRST: seam-column verts sit at
    // ±1e-16 and any sign-dependent branch would otherwise decide them
    // by floating-point luck, breaking bilateral symmetry.
    let sx0 = positions[i], sy0 = positions[i + 1], sz0 = positions[i + 2];
    if (Math.abs(sx0) < 1e-9) sx0 = 0;
    if (Math.abs(sz0) < 1e-9) sz0 = 0;
    // Input grid built at r=0.5: normalize, then scale by head radii.
    let x = sx0 * (P.rx / 0.5);
    let y = sy0 * (P.ry / 0.5);
    let z = sz0 * (P.rz / 0.5);

    // Jaw taper + chin.
    if (y < 0.02) {
      const t = Math.min(1, (0.02 - y) / 0.55);
      x *= 1 - P.jawT * t * Math.min(1, Math.abs(x) / 0.3 + 0.3);
    }
    // Chin: extend and narrow the bottom-center front. Epsilon-tolerant
    // z test: seam-column verts sit at z≈±1e-16 and must not be decided
    // by floating-point sign (that produced asymmetric chin pulls).
    if (y < -0.32 && Math.abs(x) < 0.18 && z > -1e-6) {
      y -= P.chinT * (1 - Math.abs(x) / 0.18);
      x *= 0.97;
    }
    // Cheeks + temples + brow band + skull.
    const dcL = Math.hypot(x - -0.30, y - -0.02), dcR = Math.hypot(x - 0.30, y - -0.02);
    const cheek = P.cheekT * (gauss(dcL, 0.16) + gauss(dcR, 0.16));
    if (z > 0) z += cheek * 0.5;
    if (y > 0.12 && y < 0.32 && Math.abs(x) > 0.32) x *= 1 - P.templeT * 0.5;
    if (y > 0.18 && y < 0.36 && z > 0.28) z += P.browT * Math.max(0, 1 - Math.abs(y - 0.27) / 0.12);
    if (z < -0.1) z -= P.skullT * 0.5 * Math.min(1, -z / 0.4);

    // Eye sockets (recessed wells) + lid ridges.
    for (const s of [-1, 1]) {
      const ex = s * P.eyeX;
      const dEye = Math.hypot(x - ex, y - P.eyeY);
      if (z > 0.15 && dEye < 0.17) z -= P.sockD * gauss(dEye, 0.10);
      const dLid = Math.hypot(x - ex, (y - (P.eyeY + 0.055)) * 1.6);
      if (z > 0.15 && dLid < 0.13 && y > P.eyeY) z += P.lidT * gauss(dLid, 0.07);
    }

    // Nose bridge + tip.
    if (Math.abs(x) < 0.055 && y > -0.03 && y < 0.17 && z > 0.2) {
      z += P.noseLen * gauss(Math.abs(x), 0.035) * Math.max(0, 1 - Math.abs(y - 0.07) / 0.12);
    }
    {
      const dTip = Math.hypot(x, (y + 0.03) * 1.4);
      if (z > 0.2 && dTip < 0.075) z += P.tipT * gauss(dTip, 0.05);
    }

    // Philtrum groove.
    if (Math.abs(x) < 0.022 && y > -0.11 && y < -0.05 && z > 0.2) z -= 0.008;

    // Lip volumes (protrude) + corner tuck.
    {
      const dM = Math.hypot((Math.abs(x) - P.mouthHW * 0.55) * 1.2, (y - P.mouthY) * 1.7);
      if (z > 0.15 && Math.abs(x) < P.mouthHW + 0.03 && Math.abs(y - P.mouthY) < 0.06) {
        z += P.lipFull * gauss(dM, 0.075);
      }
      const dC = Math.hypot(Math.abs(x) - P.mouthHW, y - P.mouthY);
      if (z > 0.15 && dC < 0.05) z -= 0.012 * gauss(dC, 0.03);
    }

    // Mouth cavity recess (dark interior lives behind closed lips).
    {
      const dCav = Math.hypot(x * 1.25, y - (P.mouthY - 0.005));
      if (z > 0.1 && dCav < P.mouthHW * 0.85) z -= P.cavD * gauss(dCav, P.mouthHW * 0.5);
    }

    positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
  }
  return positions;
}

function tagHeadRegions(positions, P) {
  // 0 = skin, 1 = lips, 2 = cavity (front verts only).
  const tags = new Uint8Array(positions.length / 3);
  for (let i = 0; i < tags.length; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (z < 0.1) { tags[i] = 0; continue; }
    const dCav = Math.hypot(x * 1.25, y - (P.mouthY - 0.005));
    if (dCav < P.mouthHW * 0.72 && Math.abs(y - P.mouthY) < 0.045) { tags[i] = 2; continue; }
    if (Math.abs(x) < P.mouthHW + 0.025 && Math.abs(y - P.mouthY) < 0.058) { tags[i] = 1; continue; }
    tags[i] = 0;
  }
  return tags;
}

function splitGridByTags(gridPositions, gridIndices, tags) {
  // Partition quads into 3 primitives; duplicate seam verts (normals carried).
  const fullNormals = computeNormals(gridPositions, gridIndices);
  const buckets = [[], [], []];
  const remaps = [new Map(), new Map(), new Map()];
  const outPos = [[], [], []];
  const outNrm = [[], [], []];
  const outIdx = [[], [], []];
  const tOf = (vi) => tags[vi];
  for (let f = 0; f < gridIndices.length; f += 3) {
    const vs = [gridIndices[f], gridIndices[f + 1], gridIndices[f + 2]];
    const counts = [0, 0, 0];
    for (const v of vs) counts[tOf(v)]++;
    let b = 0;
    if (counts[2] >= 2) b = 2;
    else if (counts[1] >= 2) b = 1;
    else if (counts[2] === 1 && counts[1] === 0) b = 2;
    else if (counts[1] === 1 && counts[2] === 0) b = 1;
    const remap = remaps[b];
    for (const v of vs) {
      // Seam verts take the bucket's tag so each primitive is watertight-ish.
      let id = remap.get(v);
      if (id === undefined) {
        id = outPos[b].length / 3;
        remap.set(v, id);
        outPos[b].push(gridPositions[v * 3], gridPositions[v * 3 + 1], gridPositions[v * 3 + 2]);
        outNrm[b].push(fullNormals[v * 3], fullNormals[v * 3 + 1], fullNormals[v * 3 + 2]);
      }
      outIdx[b].push(id);
    }
  }
  return [0, 1, 2].map(b => ({
    positions: new Float32Array(outPos[b]),
    normals: new Float32Array(outNrm[b]),
    indices: new Uint16Array(outIdx[b])
  }));
}

// ------------------------------------------------------- GLB writer

function buildGLB(meshes, materials, nodes, rootChildren) {
  // meshes: [{primitives: [{positions, normals, indices, material, targets?[], targetNames?[], weights?}]}]
  const binParts = [];
  const bufferViews = [];
  const accessors = [];
  const alloc = (arr, target) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const offset = binParts.reduce((s, p) => s + p.length, 0);
    const pad = (4 - (bytes.length % 4)) % 4;
    const padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes);
    binParts.push(padded);
    const idx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: padded.length, target });
    return idx;
  };
  const ARRAY = 34962, ELEMENT = 34963, FLOAT = 5126, USHORT = 5123;
  const minMax = (positions) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (positions[i + k] < mn[k]) mn[k] = positions[i + k];
        if (positions[i + k] > mx[k]) mx[k] = positions[i + k];
      }
    }
    return { min: mn, max: mx };
  };
  const accPos = (positions) => {
    const { min, max } = minMax(positions);
    accessors.push({
      bufferView: alloc(positions, ARRAY), componentType: FLOAT,
      count: positions.length / 3, type: 'VEC3', min, max
    });
    return accessors.length - 1;
  };
  const accVec3 = (arr, count) => {
    accessors.push({ bufferView: alloc(arr, ARRAY), componentType: FLOAT, count, type: 'VEC3' });
    return accessors.length - 1;
  };

  const glMeshes = meshes.map(m => ({
    primitives: m.primitives.map(p => {
      const prim = {
        attributes: { POSITION: accPos(p.positions), NORMAL: accVec3(p.normals, p.positions.length / 3) },
        indices: (() => {
          accessors.push({ bufferView: alloc(p.indices, ELEMENT), componentType: USHORT, count: p.indices.length, type: 'SCALAR' });
          return accessors.length - 1;
        })(),
        material: p.material
      };
      if (p.targets && p.targets.length) {
        prim.targets = p.targets.map(t => ({ POSITION: accVec3(t, p.positions.length / 3) }));
        prim.extras = { targetNames: p.targetNames };
      }
      return prim;
    }),
    ...(m.weights ? { weights: m.weights } : {})
  }));

  const json = {
    asset: { version: '2.0', generator: 'gosu-query-library pilot-avatar-authoring (clean-room, no third-party meshes)' },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'AvatarRoot', children: rootChildren.map((_, i) => i + 1) },
      ...nodes.map(n => ({ name: n.name, mesh: n.mesh }))],
    meshes: glMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binParts.reduce((s, p) => s + p.length, 0) }]
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const totalBin = binParts.reduce((s, p) => s + p.length, 0);
  const totalLen = 12 + 8 + jsonBytes.length + jsonPad + 8 + totalBin;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546C67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4E4F534A, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(totalBin, binStart);
  out.writeUInt32LE(0x004E4942, binStart + 4);
  let off = binStart + 8;
  for (const p of binParts) { Buffer.from(p).copy(out, off); off += p.length; }
  return out;
}

// ------------------------------------------------------- pilots

const PILOTS = {
  'toon-boy': {
    skin: '#ffcdb2', hair: '#3d2314', eye: '#ffffff', iris: '#0284c7',
    lip: '#c94a4a', shirt: '#0284c7', brow: '#2b1810',
    head: {
      rx: 0.54, ry: 0.53, rz: 0.51, jawT: 0.05, chinT: 0.005, cheekT: 0.030,
      browT: 0.008, templeT: 0.010, skullT: 0.012,
      eyeX: 0.18, eyeY: 0.10, sockD: 0.030, lidT: 0.012,
      noseLen: 0.020, tipT: 0.022, mouthY: -0.19, mouthHW: 0.160,
      lipFull: 0.020, cavD: 0.060
    },
    hairStyle: 'crop'
  },
  'adult-woman': {
    skin: '#ffe4d6', hair: '#271c19', eye: '#ffffff', iris: '#7e22ce',
    lip: '#e11d48', shirt: '#be123c', brow: '#271c19',
    head: {
      rx: 0.43, ry: 0.59, rz: 0.44, jawT: 0.13, chinT: 0.013, cheekT: 0.016,
      browT: 0.009, templeT: 0.050, skullT: 0.014,
      eyeX: 0.175, eyeY: 0.105, sockD: 0.028, lidT: 0.011,
      noseLen: 0.016, tipT: 0.018, mouthY: -0.20, mouthHW: 0.150,
      lipFull: 0.022, cavD: 0.058
    },
    hairStyle: 'wavy'
  }
};

function strandBall(r, sx, sy, sz) {
  const g = sphereGrid(14, 10, r);
  return transformGeo(g, { scale: [sx, sy, sz] });
}

function buildPilot(id) {
  const P = PILOTS[id];
  const H = P.head;
  const eyeX = H.eyeX, mouthY = H.mouthY;

  // --- head grid + shaping + split
  const grid = sphereGrid(60, 46, 0.5);
  shapeHead(grid.positions, H);
  const tags = tagHeadRegions(grid.positions, H);
  const [skinPart, lipPart, cavPart] = splitGridByTags(grid.positions, grid.indices, tags);

  const headTargets = (part) => buildTargetsForPositions(part.positions, eyeX, mouthY);
  const MAT = {
    skin: 0, lip: 1, cavity: 2, teeth: 3, tongue: 4, hair: 5,
    eyeWhite: 6, iris: 7, pupil: 8, shirt: 9, brow: 10, gold: 11
  };
  const materials = [
    hexMat(P.skin, 0.55),
    hexMat(P.lip, 0.45),
    hexMat('#2a0a12', 0.9),
    hexMat('#ffffff', 0.35),
    hexMat('#d95363', 0.6),
    { ...hexMat(P.hair, 0.6), doubleSided: true },
    hexMat('#f8fafc', 0.25),
    hexMat(P.iris, 0.3),
    hexMat('#09090b', 0.4),
    hexMat(P.shirt, 0.6),
    hexMat(P.brow, 0.6),
    hexMat('#eab308', 0.35, { pbrMetallicRoughness: { baseColorFactor: [...srgbToLinear('#eab308'), 1], metallicFactor: 0.6, roughnessFactor: 0.35 } })
  ];

  const meshes = [];
  const nodes = [];
  const addMesh = (name, primitives, weights) => {
    meshes.push({ primitives, ...(weights ? { weights } : {}) });
    nodes.push({ name, mesh: meshes.length - 1 });
    return meshes.length - 1;
  };

  const zero8 = new Array(8).fill(0);
  addMesh('Head', [
    { ...skinPart, material: MAT.skin, targets: headTargets(skinPart), targetNames: SPEC_TARGETS },
    { ...lipPart, material: MAT.lip, targets: headTargets(lipPart), targetNames: SPEC_TARGETS },
    { ...cavPart, material: MAT.cavity, targets: headTargets(cavPart), targetNames: SPEC_TARGETS }
  ], [...zero8]);

  // --- teeth: curved strips inside the recess
  const teethStrip = (y, w, h) => {
    const g = sphereGrid(16, 2, 1);
    const p = g.positions;
    for (let i = 0; i < p.length; i += 3) {
      const nx = p[i], ny = p[i + 1];
      p[i] = nx * w;
      p[i + 1] = y + (ny + 1) * 0.5 * h;
      p[i + 2] = 0.372 + (1 - Math.abs(nx)) * 0.006;
    }
    g.normals = computeNormals(p, g.indices);
    return g;
  };
  const upperTeeth = teethStrip(mouthY + 0.006, 0.075, 0.030);
  addMesh('TeethUpper', [{
    positions: upperTeeth.positions, normals: upperTeeth.normals, indices: upperTeeth.indices,
    material: MAT.teeth, targets: buildTargetsForPositions(upperTeeth.positions, eyeX, mouthY).map(() => new Float32Array(upperTeeth.positions.length)), targetNames: SPEC_TARGETS
  }], [...zero8]);

  const lowerTeethGeo = teethStrip(mouthY - 0.038, 0.065, 0.026);
  const jawOnly = (positions) => {
    const tmp = [0, 0, 0];
    const arr = new Float32Array(positions.length);
    for (let i = 0; i < positions.length / 3; i++) {
      morphJaw(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], tmp);
      arr[i * 3] = tmp[0]; arr[i * 3 + 1] = tmp[1]; arr[i * 3 + 2] = tmp[2];
    }
    return arr;
  };
  addMesh('TeethLower', [{
    positions: lowerTeethGeo.positions, normals: lowerTeethGeo.normals, indices: lowerTeethGeo.indices,
    material: MAT.teeth, targets: [jawOnly(lowerTeethGeo.positions)], targetNames: ['jawOpen']
  }], [0]);

  // --- tongue: flattened ball tucked in the recess, rides the jaw
  const tongueGeo = transformGeo(sphereGrid(14, 10, 0.055), { scale: [1.2, 0.35, 0.7], translate: [0, mouthY - 0.032, 0.360] });
  tongueGeo.normals = computeNormals(tongueGeo.positions, tongueGeo.indices);
  addMesh('Tongue', [{
    positions: tongueGeo.positions, normals: tongueGeo.normals, indices: tongueGeo.indices,
    material: MAT.tongue, targets: [jawOnly(tongueGeo.positions)], targetNames: ['jawOpen']
  }], [0]);

  // --- eyes: sclera + iris + pupil + catchlight (static, behind modeled lids)
  for (const s of [-1, 1]) {
    const cx = s * eyeX, cy = H.eyeY;
    const sclera = transformGeo(sphereGrid(16, 12, 0.085), { scale: [1, 1.12, 0.8], translate: [cx, cy, 0.395] });
    sclera.normals = computeNormals(sclera.positions, sclera.indices);
    const iris = transformGeo(discMesh(0.045), { translate: [cx, cy - 0.004, 0.462] });
    iris.normals = computeNormals(iris.positions, iris.indices);
    const pupil = transformGeo(discMesh(0.022), { translate: [cx, cy - 0.004, 0.466] });
    pupil.normals = computeNormals(pupil.positions, pupil.indices);
    const catchl = transformGeo(discMesh(0.011), { translate: [cx + s * 0.016, cy + 0.016, 0.468] });
    catchl.normals = computeNormals(catchl.positions, catchl.indices);
    const nm = s < 0 ? 'EyeL' : 'EyeR';
    addMesh(nm + '_Sclera', [{ positions: sclera.positions, normals: sclera.normals, indices: sclera.indices, material: MAT.eyeWhite }]);
    addMesh(nm + '_Iris', [{ positions: iris.positions, normals: iris.normals, indices: iris.indices, material: MAT.iris }]);
    addMesh(nm + '_Pupil', [{ positions: pupil.positions, normals: pupil.normals, indices: pupil.indices, material: MAT.pupil }]);
    addMesh(nm + '_Catchlight', [{ positions: catchl.positions, normals: catchl.normals, indices: catchl.indices, material: MAT.teeth }]);
  }

  // --- brows: thin curved strips with their own browInnerUp target
  for (const s of [-1, 1]) {
    const g = sphereGrid(10, 2, 1);
    const p = g.positions;
    const thick = id === 'adult-woman' ? 0.016 : 0.022;
    for (let i = 0; i < p.length; i += 3) {
      const nx = p[i];
      p[i] = s * eyeX + nx * 0.085;
      p[i + 1] = H.eyeY + 0.135 + p[i + 1] * thick + Math.abs(nx) * -0.012;
      p[i + 2] = 0.452 + (1 - Math.abs(nx)) * 0.004;
    }
    g.normals = computeNormals(p, g.indices);
    const tmp = [0, 0, 0];
    const arr = new Float32Array(p.length);
    for (let i = 0; i < p.length / 3; i++) {
      morphBrow(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], tmp);
      arr[i * 3] = tmp[0]; arr[i * 3 + 1] = tmp[1]; arr[i * 3 + 2] = tmp[2];
    }
    addMesh(s < 0 ? 'BrowL' : 'BrowR', [{
      positions: p, normals: g.normals, indices: g.indices,
      material: MAT.brow, targets: [arr], targetNames: ['browInnerUp']
    }], [0]);
  }

  // --- ears
  for (const s of [-1, 1]) {
    const g = transformGeo(sphereGrid(12, 10, 0.105), {
      scale: [0.35, 1.0, 0.6], translate: [s * (H.rx + 0.015), 0.0, -0.03]
    });
    g.normals = computeNormals(g.positions, g.indices);
    addMesh(s < 0 ? 'EarL' : 'EarR', [{ positions: g.positions, normals: g.normals, indices: g.indices, material: MAT.skin }]);
  }

  // --- neck + trapezius + collar ring
  const neck = transformGeo(cylinderMesh(0.17, 0.20, 0.24), { translate: [0, -0.58, 0] });
  neck.normals = computeNormals(neck.positions, neck.indices);
  addMesh('Neck', [{ positions: neck.positions, normals: neck.normals, indices: neck.indices, material: MAT.skin }]);
  const trap = transformGeo(sphereGrid(20, 14, 0.30), { scale: [1.5, 0.65, 0.85], translate: [0, -0.74, -0.03] });
  trap.normals = computeNormals(trap.positions, trap.indices);
  addMesh('Shoulders', [{ positions: trap.positions, normals: trap.normals, indices: trap.indices, material: MAT.shirt }]);
  const collar = transformGeo(torusMesh(0.20, 0.035), { rotX: Math.PI / 2 - 0.12, translate: [0, -0.63, 0.01] });
  collar.normals = computeNormals(collar.positions, collar.indices);
  addMesh('Collar', [{ positions: collar.positions, normals: collar.normals, indices: collar.indices, material: MAT.shirt }]);

  // --- hair
  const hairMeshes = [];
  const pushHair = (geo) => {
    geo.normals = computeNormals(geo.positions, geo.indices);
    hairMeshes.push({ positions: geo.positions, normals: geo.normals, indices: geo.indices, material: MAT.hair });
  };
  // Seated cap shell over the crown.
  pushHair(transformGeo(sphereGrid(24, 12, 0.5, [0, 0, 0], [1, 1, 1], Math.PI * 0.62), {
    scale: [H.rx / 0.5 * 1.06, H.ry / 0.5 * 1.02, H.rz / 0.5], translate: [0, 0.08, -0.03]
  }));
  if (P.hairStyle === 'crop') {
    const spikes = [
      [-0.24, 0.56, 0.10, 0.115, -0.28], [0.0, 0.60, 0.14, 0.125, 0.0], [0.24, 0.56, 0.10, 0.115, 0.28],
      [-0.12, 0.58, -0.06, 0.11, -0.12], [0.12, 0.58, -0.06, 0.11, 0.12]
    ];
    for (const [x, y, z, r, rz] of spikes) {
      pushHair(transformGeo(strandBall(r, 0.85, 1.25, 0.8), { translate: [x, y, z], rotZ: rz }));
    }
    for (let k = 0; k < 5; k++) {
      const t = k / 4 * 2 - 1;
      pushHair(transformGeo(strandBall(0.085, 0.9, 1.15 - Math.abs(t) * 0.45, 0.75), {
        translate: [t * 0.30, 0.44 - Math.abs(t) * 0.03, 0.36], rotZ: t * -0.18
      }));
    }
  } else {
    // Wavy frame + locks + fringe + gold hoops.
    pushHair(transformGeo(torusMesh(0.52, 0.12), { translate: [0, 0.1, -0.05] }));
    for (const s of [-1, 1]) {
      pushHair(transformGeo(strandBall(0.13, 0.85, 1.6, 0.9), { translate: [s * 0.44, 0.05, 0.10], rotZ: s * -0.15 }));
      pushHair(transformGeo(strandBall(0.11, 0.85, 1.6, 0.9), { translate: [s * 0.46, -0.22, 0.08], rotZ: s * -0.12 }));
    }
    for (let k = 0; k < 6; k++) {
      const t = k / 5 * 2 - 1;
      pushHair(transformGeo(strandBall(0.075, 0.9, 1.2, 0.75), {
        translate: [t * 0.27, 0.44 - Math.abs(t) * 0.03, 0.34], rotZ: t * -0.18
      }));
    }
    for (const s of [-1, 1]) {
      const hoop = transformGeo(torusMesh(0.08, 0.015), { translate: [s * 0.48, -0.12, 0] });
      hoop.normals = computeNormals(hoop.positions, hoop.indices);
      addMesh(s < 0 ? 'EarringL' : 'EarringR', [{
        positions: hoop.positions, normals: hoop.normals, indices: hoop.indices, material: MAT.gold
      }]);
    }
  }
  addMesh('Hair', hairMeshes);

  const glb = buildGLB(meshes, materials, nodes, nodes.map((_, i) => i));
  return glb;
}

// ------------------------------------------------------- main

for (const id of Object.keys(PILOTS)) {
  const glb = buildPilot(id);
  for (const base of OUT_DIRS) {
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.glb`), glb);
  }
  console.log(`${id}: ${(glb.length / 1024).toFixed(1)} KB`);
}
