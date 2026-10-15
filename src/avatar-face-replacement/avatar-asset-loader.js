/**
 * Standalone 3D Avatar Face Replacement — 3D Character Asset Loader & Registry
 *
 * Provides isolated 3D character asset loader and registry for GLB/GLTF assets.
 * Maps 3D character assets to common facial animation contract:
 * - jawOpen
 * - eyeBlinkLeft / eyeBlinkRight
 * - mouthSmileLeft / mouthSmileRight
 * - mouthFunnel
 * - mouthPucker
 * - browInnerUp / browDownLeft / browDownRight
 * - head pitch/yaw/roll
 */

import { createProcedural3DToonAvatar, AVATAR_CHARACTER_LIST } from './avatar-model-generator.js';

export { AVATAR_CHARACTER_LIST };

export const AVATAR_CHARACTER_REGISTRY = [
  ...AVATAR_CHARACTER_LIST,
  {
    id: 'character-01',
    name: 'Toon Bobblehead Boy',
    category: 'Stylized Toon',
    previewUrl: '/avatar-assets/character-01/preview.svg',
    glbUrl: '/avatar-assets/character-01/character.glb',
    description: 'Polished stylized 3D cartoon bobblehead character with expressive eyes, eyelids, mouth blendshapes, hair, and clean proportions.',
    badge: '★ Featured 3D GLB'
  }
];

/**
 * P1 pilot assets: clean-room authored GLB base-family models with baked
 * morph targets (see docs/avatar-asset-spec.md). Procedural builders remain
 * untouched as the automatic fallback if a GLB is missing or corrupt.
 */
export const PILOT_CHARACTER_GLB = {
  'toon-boy': '/avatar-assets/toon-boy/toon-boy.glb',
  'adult-woman': '/avatar-assets/adult-woman/adult-woman.glb'
};

export class AvatarAssetLoader {
  constructor(THREE = null, GLTFLoaderClass = null) {
    this.THREE = THREE;
    this.GLTFLoaderClass = GLTFLoaderClass;
    this.cache = new Map();
    this.customBuilders = new Map();
  }

  /**
   * Register a personalized character definition and model builder
   */
  registerPersonalizedCharacter(characterItem, modelBuilder) {
    if (!characterItem || !characterItem.id) return;
    const existingIndex = AVATAR_CHARACTER_REGISTRY.findIndex(c => c.id === characterItem.id);
    if (existingIndex >= 0) {
      AVATAR_CHARACTER_REGISTRY[existingIndex] = characterItem;
    } else {
      AVATAR_CHARACTER_REGISTRY.push(characterItem);
    }
    if (modelBuilder) {
      this.customBuilders.set(characterItem.id, modelBuilder);
    }
    this.cache.delete(characterItem.id);
  }

  /**
   * Set Three.js and GLTFLoader instances
   */
  setDependencies(THREE, GLTFLoaderClass) {
    this.THREE = THREE;
    this.GLTFLoaderClass = GLTFLoaderClass;
  }

  /**
   * Retrieve character manifest item by ID
   */
  getCharacterInfo(characterId = 'character-01') {
    return AVATAR_CHARACTER_REGISTRY.find(c => c.id === characterId) || AVATAR_CHARACTER_REGISTRY[0];
  }

  /**
   * Load 3D Character Asset (GLB/GLTF) or return prepared character model
   */
  async loadCharacterAsset(characterId = 'character-01') {
    // Check if custom builder registered (e.g. My Character from photo generator)
    if (this.customBuilders.has(characterId)) {
      const builder = this.customBuilders.get(characterId);
      const customModel = builder(this.THREE);
      if (customModel) {
        customModel.userData.characterId = characterId;
        return customModel;
      }
    }

    const charInfo = this.getCharacterInfo(characterId);
    const glbUrl = PILOT_CHARACTER_GLB[characterId] || charInfo.glbUrl;

    // Return cached character object if available
    if (this.cache.has(characterId)) {
      return this.cache.get(characterId).clone();
    }

    const THREE = this.THREE;

    // Use GLTFLoader if available in browser runtime
    if (this.GLTFLoaderClass && typeof fetch !== 'undefined') {
      try {
        const loader = new this.GLTFLoaderClass();
        const gltf = await new Promise((resolve, reject) => {
          loader.load(
            glbUrl,
            gltf => resolve(gltf),
            undefined,
            err => reject(err)
          );
        });

        if (gltf && gltf.scene) {
          const avatarGroup = gltf.scene;
          avatarGroup.name = `AvatarToonCharacterGroup_${characterId}`;

          // Locate head mesh with morph targets or bind root scene
          let headMesh = null;
          let morphDict = {};

          avatarGroup.traverse(child => {
            if (child.isMesh && child.morphTargetDictionary) {
              headMesh = child;
              morphDict = child.morphTargetDictionary;
            }
          });

          if (!headMesh) {
            headMesh = avatarGroup;
          }

          avatarGroup.userData = {
            characterId,
            headMesh,
            morphTargetDictionary: morphDict,
            isGLBAsset: true
          };

          avatarGroup.morphTargetDictionary = morphDict;

          this.cache.set(characterId, avatarGroup);
          return avatarGroup;
        }
      } catch (err) {
        console.warn(`[AvatarAssetLoader] Failed to load GLB from ${glbUrl}, using fallthrough contract model`, err);
      }
    }

    // Fallback: Generate procedural 3D toon model matching contract
    const fallbackModel = createProcedural3DToonAvatar(THREE, characterId);
    if (fallbackModel) {
      fallbackModel.userData.isGLBAsset = false;
      fallbackModel.userData.characterId = characterId;
    }
    return fallbackModel;
  }
}
