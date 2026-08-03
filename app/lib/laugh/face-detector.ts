import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceSample } from './types';

// MediaPipe's runtime (WASM) and the model are loaded lazily and only once, the
// first time a match starts — so nothing here is in the initial bundle and the
// landing page stays light. Version must match the installed package (1.0.0).
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let modulePromise: Promise<typeof import('@mediapipe/tasks-vision')> | null = null;
function loadVision() {
  if (!modulePromise) modulePromise = import('@mediapipe/tasks-vision');
  return modulePromise;
}

// MediaPipe's WASM prints TFLite/XNNPACK init lines through console.error even
// though they are informational (e.g. "INFO: Created TensorFlow Lite XNNPACK
// delegate for CPU."), which Next's dev overlay then reports as "Console Error".
//
// Those lines are only emitted while the model initializes, so the filter is
// installed for exactly that window and always removed afterwards. An earlier
// version replaced console.error/console.info permanently, which swallowed any
// later message starting with "INFO:" (real errors included) and stacked extra
// wrappers on every hot reload.
const BENIGN_MEDIAPIPE_LOG = /Created TensorFlow Lite XNNPACK delegate|^INFO:|GL version|gl_context/i;

export async function withMediapipeLogsSilenced<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined') return operation();

  const originalError = console.error;
  const originalWarn = console.warn;
  const filter =
    (original: typeof console.error): typeof console.error =>
    (...args) => {
      if (typeof args[0] === 'string' && BENIGN_MEDIAPIPE_LOG.test(args[0])) return;
      original(...args);
    };

  console.error = filter(originalError);
  console.warn = filter(originalWarn);
  try {
    return await operation();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

// MediaPipe 468-mesh indices around the lips (corners + inner/outer top/bottom).
const MOUTH_LANDMARKS = [61, 291, 0, 17, 13, 14, 78, 308, 40, 270];

export class FaceDetector {
  private landmarker: FaceLandmarker | null = null;
  private lastVideoTime = -1;

  async init(): Promise<void> {
    this.landmarker = await withMediapipeLogsSilenced(async () => {
      const vision = await loadVision();
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      return vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    });
  }

  get ready() {
    return this.landmarker !== null;
  }

  // Returns null when there is no new frame to process; otherwise a FaceSample
  // whose faceAvailable flag says whether a face was actually found.
  detect(video: HTMLVideoElement, now: number): FaceSample | null {
    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const result = this.landmarker.detectForVideo(video, now);
    const categories = result.faceBlendshapes?.[0]?.categories;
    const landmarks = result.faceLandmarks?.[0];
    if (!categories || !landmarks) return { faceAvailable: false };

    const score = (name: string) =>
      categories.find((c) => c.categoryName === name)?.score ?? 0;

    const features = {
      smile: (score('mouthSmileLeft') + score('mouthSmileRight')) / 2,
      jawOpen: score('jawOpen'),
      eyeSquint: (score('cheekSquintLeft') + score('cheekSquintRight')) / 2,
    };

    // Bounding box from landmark extents (normalized 0..1) for the overlay.
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const p of landmarks) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    // Tight box around the mouth (lip corners + top/bottom lip landmarks), padded
    // a little, so a hand-over-mouth check has a region to test against.
    let mMinX = 1;
    let mMinY = 1;
    let mMaxX = 0;
    let mMaxY = 0;
    for (const i of MOUTH_LANDMARKS) {
      const p = landmarks[i];
      if (!p) continue;
      if (p.x < mMinX) mMinX = p.x;
      if (p.y < mMinY) mMinY = p.y;
      if (p.x > mMaxX) mMaxX = p.x;
      if (p.y > mMaxY) mMaxY = p.y;
    }
    const padX = (mMaxX - mMinX) * 0.4;
    const padY = (mMaxY - mMinY) * 0.6;

    return {
      faceAvailable: true,
      features,
      box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      mouthBox: {
        x: mMinX - padX,
        y: mMinY - padY,
        w: mMaxX - mMinX + padX * 2,
        h: mMaxY - mMinY + padY * 2,
      },
    };
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
    this.lastVideoTime = -1;
  }
}
