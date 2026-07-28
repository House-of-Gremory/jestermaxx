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

export class FaceDetector {
  private landmarker: FaceLandmarker | null = null;
  private lastVideoTime = -1;

  async init(): Promise<void> {
    const vision = await loadVision();
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
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

    return {
      faceAvailable: true,
      features,
      box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    };
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
    this.lastVideoTime = -1;
  }
}
