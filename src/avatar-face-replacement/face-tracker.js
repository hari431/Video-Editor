/**
 * Standalone 3D Avatar Face Replacement — Face Tracker Module
 *
 * MediaPipe Face Landmarker integration & Blendshape Extractor.
 * Extracts 478 3D landmarks, 52 ARKit-compatible facial blendshapes,
 * and 3D head transformation matrix (Rotation + Translation).
 *
 * Designed to be extensible for multiple independently tracked faces.
 */

export class AvatarFaceTracker {
  constructor(options = {}) {
    this.numFaces = options.numFaces || 1;
    this.minDetectionConfidence = options.minDetectionConfidence || 0.5;
    this.minTrackingConfidence = options.minTrackingConfidence || 0.5;
    this.landmarker = null;
    this.isInitialized = false;
  }

  /**
   * Initialize MediaPipe Tasks Vision FaceLandmarker.
   * Uses browser CDN or provided Vision task module.
   */
  async initialize(visionModule) {
    if (this.isInitialized) return;

    if (!visionModule) {
      throw new Error('Vision module is required to initialize AvatarFaceTracker');
    }

    const { FaceLandmarker, FilesetResolver } = visionModule;

    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU'
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: 'VIDEO',
        numFaces: this.numFaces,
        minFaceDetectionConfidence: this.minDetectionConfidence,
        minFacePresenceConfidence: this.minTrackingConfidence,
        minTrackingConfidence: this.minTrackingConfidence
      });
    } catch (gpuErr) {
      console.warn('[AVATAR-TRACKER] GPU delegate failed, falling back to CPU delegate:', gpuErr);
      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'CPU'
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: 'VIDEO',
        numFaces: this.numFaces,
        minFaceDetectionConfidence: this.minDetectionConfidence,
        minFacePresenceConfidence: this.minTrackingConfidence,
        minTrackingConfidence: this.minTrackingConfidence
      });
    }

    this.isInitialized = true;
  }

  /**
   * Process a single video frame or image element.
   * Returns standardized multi-face tracking data payload.
   */
  detectFrame(videoElement, timestampMs) {
    if (!this.isInitialized || !this.landmarker) {
      return { ok: false, error: 'Tracker not initialized', faces: [] };
    }

    try {
      const results = this.landmarker.detectForVideo(videoElement, timestampMs);
      const faces = [];

      if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        for (let i = 0; i < results.faceLandmarks.length; i++) {
          const rawLandmarks = results.faceLandmarks[i];
          const rawBlendshapes = results.faceBlendshapes ? results.faceBlendshapes[i] : null;
          const rawMatrix = results.facialTransformationMatrixes ? results.facialTransformationMatrixes[i] : null;

          const parsedBlendshapes = {};
          if (rawBlendshapes && rawBlendshapes.categories) {
            for (const category of rawBlendshapes.categories) {
              parsedBlendshapes[category.categoryName] = category.score;
            }
          }

          const poseTransform = extractHeadPoseFromLandmarks(rawLandmarks, rawMatrix);

          faces.push({
            faceId: i,
            landmarks: rawLandmarks,
            blendshapes: parsedBlendshapes,
            transform: poseTransform,
            boundingBox: computeFaceBoundingBox(rawLandmarks)
          });
        }
      }

      return {
        ok: true,
        timestampMs,
        facesCount: faces.length,
        faces
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message || 'Detection error',
        faces: []
      };
    }
  }
}

export const FilmymojiFaceTracker = AvatarFaceTracker;

/**
 * Extract 3D head position, scale, and Euler angles (Pitch, Yaw, Roll)
 * from 3D face landmarks or transformation matrix.
 */
export function extractHeadPoseFromLandmarks(landmarks, matrix) {
  if (!landmarks || landmarks.length === 0) {
    return {
      position: { x: 0, y: 0, z: 0 },
      rotation: { pitch: 0, yaw: 0, roll: 0 },
      matrix: matrix || null
    };
  }

  // Key facial anchor landmarks (Nose Tip: 1, Chin: 152, Left Eye Outer: 33, Right Eye Outer: 263)
  const noseTip = landmarks[1];
  const chin = landmarks[152];
  const leftEyeOuter = landmarks[33];
  const rightEyeOuter = landmarks[263];

  // Center position of face in normalized coordinates
  const centerX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
  const centerY = (leftEyeOuter.y + chin.y) / 2;
  const centerZ = (noseTip.z + chin.z) / 2;

  // Face bounding dimensions for scale estimation
  const faceWidth = Math.hypot(rightEyeOuter.x - leftEyeOuter.x, rightEyeOuter.y - leftEyeOuter.y);
  const faceHeight = Math.hypot(chin.x - noseTip.x, chin.y - noseTip.y);

  // Approximate Yaw (head turn left/right)
  const eyeDx = rightEyeOuter.x - leftEyeOuter.x;
  const eyeDz = rightEyeOuter.z - leftEyeOuter.z;
  const yaw = Math.atan2(eyeDz, eyeDx);

  // Approximate Pitch (head tilt up/down)
  const chinDy = chin.y - noseTip.y;
  const chinDz = chin.z - noseTip.z;
  const pitch = Math.atan2(chinDz, chinDy);

  // Approximate Roll (head tilt side/side)
  const eyeDy = rightEyeOuter.y - leftEyeOuter.y;
  const roll = Math.atan2(eyeDy, eyeDx);

  return {
    position: { x: centerX, y: centerY, z: centerZ },
    scale: { width: faceWidth, height: faceHeight },
    rotation: { pitch, yaw, roll },
    matrix: matrix || null
  };
}

/**
 * Calculate bounding box [minX, minY, maxX, maxY] in normalized coordinates [0, 1].
 */
export function computeFaceBoundingBox(landmarks) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
