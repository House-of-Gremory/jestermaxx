import type { HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandPoint } from './types';

// Lazily loaded, like the face model, so nothing ships in the initial bundle.
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let modulePromise: Promise<typeof import('@mediapipe/tasks-vision')> | null = null;
function loadVision() {
  if (!modulePromise) modulePromise = import('@mediapipe/tasks-vision');
  return modulePromise;
}

// Detects hands so the caller can tell when one is held over the mouth. Runs at a
// low rate; it never sends anything anywhere — points stay in the browser.
export class HandDetector {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;

  async init(): Promise<void> {
    const vision = await loadVision();
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  }

  get ready() {
    return this.landmarker !== null;
  }

  // Returns null when there is no new frame; otherwise a (possibly empty) list of
  // hands, each as normalized [0..1] landmark points.
  detect(video: HTMLVideoElement, now: number): HandPoint[][] | null {
    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const result = this.landmarker.detectForVideo(video, now);
    return (result.landmarks ?? []).map((hand) => hand.map((p) => ({ x: p.x, y: p.y })));
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
    this.lastVideoTime = -1;
  }
}
