/**
 * Standalone 3D Avatar Face Replacement — Shared Hairstyle Asset Catalogue
 *
 * ONE catalogue drives BOTH the SVG thumbnail and the Three.js hair mass,
 * so the gallery preview and the live model can never disagree about hair.
 *
 * Each asset: { id, label, svg(color), build3D(THREE, material, fit) }.
 * fit = { sx } head-width factor used to seat the asset on measured heads.
 * Builders must only use Sphere/Box/Torus geometries (mock-compatible).
 */

// Legacy extractor style names keep working (backward compatibility).
export const LEGACY_STYLE_TO_ASSET = {
  'styled-side-part': 'side-part',
  'messy-volume': 'textured-crop',
  'wavy-curly': 'curly-top',
  'bob-medium': 'wavy-bob',
  'long-flowing': 'long-straight',
  'buzz-cut': 'buzz',
  'bald': 'bald'
};

export function resolveHairAsset(styleOrAsset) {
  if (HAIR_ASSETS[styleOrAsset]) return styleOrAsset;
  if (LEGACY_STYLE_TO_ASSET[styleOrAsset]) return LEGACY_STYLE_TO_ASSET[styleOrAsset];
  return 'side-part';
}

/**
 * Conservative volume→asset classification. Strong evidence required for
 * long/bald extremes; everything uncertain becomes a short neat cut.
 */
export function classifyHairAsset({ topVolume = 0, sideVolume = 0, skinLum = 180, hairLum = 60 } = {}) {
  if (hairLum > skinLum - 15 && topVolume < 150) return 'bald';
  if (sideVolume > 400) return 'long-straight';
  if (sideVolume > 250) return 'wavy-bob';
  if (topVolume > 1200) return 'curly-top';
  if (topVolume > 800) return 'textured-crop';
  if (topVolume < 400) {
    return sideVolume > 150 ? 'fade' : 'buzz';
  }
  return 'side-part';
}

function sphere(THREE, r, w = 16, h = 12) {
  return new THREE.SphereGeometry(r, w, h);
}

function mesh(THREE, geom, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geom, material);
  m.position.set(x, y, z);
  return m;
}

// Full skull cap slightly LARGER than the head so hair never hides inside it.
function baseCap(THREE, material, fit) {
  const g = new THREE.Group();
  const sx = (fit && fit.sx) || 1;
  const capGeom = new THREE.SphereGeometry(0.56 * sx, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.62);
  g.add(mesh(THREE, capGeom, material, 0, 0.08, -0.03));
  const backGeom = sphere(THREE, 0.34, 18, 14);
  backGeom.scale(1.25 * sx, 1.35, 0.9);
  g.add(mesh(THREE, backGeom, material, 0, 0.12, -0.28));
  return g;
}

function mergeGroups(THREE, ...groups) {
  const out = new THREE.Group();
  out.name = 'HairAssetGroup';
  for (const grp of groups) {
    if (grp && grp.children) {
      for (const child of grp.children) out.add(child);
    } else if (grp) {
      out.add(grp);
    }
  }
  return out;
}

export const HAIR_ASSETS = {
  'side-part': {
    id: 'side-part',
    label: 'Side Part',
    svg: (hair) => `
      <path d="M 44 80 Q 48 24 100 22 Q 152 24 156 80 Q 135 48 95 54 Q 60 48 44 80 Z" fill="${hair}"/>
      <path d="M 44 80 Q 70 42 110 52 Q 80 70 48 88 Z" fill="${hair}" opacity="0.9"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const bangGeom = sphere(THREE, 0.20, 16, 12);
      bangGeom.scale(1.5, 0.55, 0.8);
      const bang = mesh(THREE, bangGeom, material, -0.08, 0.42, 0.34);
      bang.rotation.set(-0.35, 0.25, -0.25);
      g.add(bang);
      const sideGeom = sphere(THREE, 0.16, 14, 12);
      sideGeom.scale(0.8, 1.4, 1.0);
      g.add(mesh(THREE, sideGeom, material, 0.30, 0.18, 0.10));
      return mergeGroups(THREE, g);
    }
  },
  'textured-crop': {
    id: 'textured-crop',
    label: 'Textured Crop',
    svg: (hair) => `
      <path d="M 44 80 Q 40 30 75 20 Q 100 10 125 20 Q 160 30 156 80 Q 140 45 100 50 Q 60 45 44 80 Z" fill="${hair}"/>
      <path d="M 60 34 L 68 18 L 76 32 Z" fill="${hair}"/>
      <path d="M 92 30 L 100 14 L 108 30 Z" fill="${hair}"/>
      <path d="M 124 34 L 132 18 L 140 32 Z" fill="${hair}"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const spikes = [
        [-0.22, 0.55, 0.12, -0.25], [0.0, 0.60, 0.16, 0.0], [0.22, 0.55, 0.12, 0.25],
        [-0.10, 0.58, -0.05, -0.1], [0.12, 0.58, -0.05, 0.1]
      ];
      for (const [x, y, z, tilt] of spikes) {
        const tuft = mesh(THREE, sphere(THREE, 0.11, 12, 10), material, x, y, z);
        tuft.scale.set(0.9, 1.3, 0.9);
        tuft.rotation.z = tilt;
        g.add(tuft);
      }
      return mergeGroups(THREE, g);
    }
  },
  'curly-top': {
    id: 'curly-top',
    label: 'Curly Top',
    svg: (hair) => `
      <path d="M 44 80 Q 40 30 75 20 Q 100 10 125 20 Q 160 30 156 80 Q 140 45 100 50 Q 60 45 44 80 Z" fill="${hair}"/>
      <circle cx="65" cy="28" r="18" fill="${hair}"/>
      <circle cx="100" cy="20" r="20" fill="${hair}"/>
      <circle cx="135" cy="28" r="18" fill="${hair}"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const tufts = [
        [-0.18, 0.52, 0.18, 0.14], [0.0, 0.56, 0.22, 0.16], [0.18, 0.52, 0.18, 0.14],
        [-0.28, 0.42, 0.05, 0.13], [0.28, 0.42, 0.05, 0.13], [0.0, 0.58, -0.10, 0.15]
      ];
      for (const [x, y, z, r] of tufts) {
        g.add(mesh(THREE, sphere(THREE, r, 12, 10), material, x, y, z));
      }
      return mergeGroups(THREE, g);
    }
  },
  'wavy-bob': {
    id: 'wavy-bob',
    label: 'Wavy Bob',
    svg: (hair) => `
      <path d="M 42 85 Q 45 22 100 22 Q 155 22 158 85 Q 162 135 150 140 Q 142 120 142 90 Q 100 50 58 90 Q 58 120 50 140 Q 38 135 42 85 Z" fill="${hair}"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const sideGeom = sphere(THREE, 0.22, 16, 14);
      sideGeom.scale(0.8, 1.8, 1.2);
      g.add(mesh(THREE, sideGeom, material, -0.40, -0.08, 0.05));
      const sideGeomR = sphere(THREE, 0.22, 16, 14);
      sideGeomR.scale(0.8, 1.8, 1.2);
      g.add(mesh(THREE, sideGeomR, material, 0.40, -0.08, 0.05));
      return mergeGroups(THREE, g);
    }
  },
  'long-straight': {
    id: 'long-straight',
    label: 'Long Straight',
    svg: (hair) => `
      <path d="M 40 90 Q 42 20 100 20 Q 158 20 160 90 Q 165 140 160 165 C 150 165 145 130 145 100 Q 100 55 55 100 C 55 130 50 165 40 165 Q 35 140 40 90 Z" fill="${hair}"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const lockGeom = sphere(THREE, 0.13, 14, 12);
      lockGeom.scale(0.85, 2.4, 1.0);
      g.add(mesh(THREE, lockGeom, material, -0.40, -0.18, 0.16));
      const lockGeomR = sphere(THREE, 0.13, 14, 12);
      lockGeomR.scale(0.85, 2.4, 1.0);
      g.add(mesh(THREE, lockGeomR, material, 0.40, -0.18, 0.16));
      const backLong = sphere(THREE, 0.30, 16, 14);
      backLong.scale(1.3, 1.9, 0.8);
      g.add(mesh(THREE, backLong, material, 0, -0.25, -0.30));
      return mergeGroups(THREE, g);
    }
  },
  'buzz': {
    id: 'buzz',
    label: 'Buzz Cut',
    svg: (hair) => `
      <path d="M 48 80 Q 50 32 100 32 Q 150 32 152 80 Q 130 52 100 55 Q 70 52 48 80 Z" fill="${hair}"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const shade = new THREE.SphereGeometry(0.54, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.45);
      g.add(mesh(THREE, shade, material, 0, 0.10, -0.03));
      return mergeGroups(THREE, g);
    }
  },
  'fade': {
    id: 'fade',
    label: 'Short Fade',
    svg: (hair) => `
      <path d="M 50 78 Q 54 36 100 34 Q 146 36 150 78 Q 128 56 100 58 Q 72 56 50 78 Z" fill="${hair}"/>
      <path d="M 50 78 L 46 96 L 54 96 Z" fill="${hair}" opacity="0.85"/>
      <path d="M 150 78 L 154 96 L 146 96 Z" fill="${hair}" opacity="0.85"/>
    `,
    build3D(THREE, material, fit) {
      const g = baseCap(THREE, material, fit);
      const topGeom = sphere(THREE, 0.20, 16, 12);
      topGeom.scale(1.6, 0.5, 1.0);
      g.add(mesh(THREE, topGeom, material, 0, 0.50, 0.05));
      return mergeGroups(THREE, g);
    }
  },
  'bald': {
    id: 'bald',
    label: 'Bald',
    svg: () => '',
    build3D(THREE) {
      const g = new THREE.Group();
      g.name = 'HairAssetGroup';
      return g;
    }
  }
};

export const HAIR_ASSET_IDS = Object.keys(HAIR_ASSETS);
