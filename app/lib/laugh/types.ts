// Shared types for the laugh-detection pipeline. Kept deliberately small: the
// heavy per-frame feature data lives in class instances/refs, never in React
// state or on the wire. Only a confirmed LaughEvent ever leaves the detector.

export type AudioFeatures = {
  rms: number; // overall loudness / energy of the window
  zcr: number; // zero-crossing rate 0..1 (noisiness)
  centroid: number; // spectral centroid 0..1 (brightness)
  highBandEnergy: number; // 0..1 share of energy above the voice fundamental
};

export type ScoreReason = 'laugh' | 'smile' | 'face-timeout' | 'mouth-cover';

// The only object that crosses a boundary (to the opponent / a future server).
// No media, no landmarks, no feature arrays — see LAUGH-DETECTION spec §8.
export type LaughEvent = {
  clientEventId: string;
  occurredAt: number;
  durationMs: number;
  confidence: number;
  detectorVersion: string;
  reason: ScoreReason; // laugh, sustained-smile bonus, or face-not-shown penalty
  points: number; // points awarded to the opponent for this event
};

export type FaceFeatures = {
  smile: number; // 0..1, average of mouthSmileLeft/Right blendshapes
  jawOpen: number; // 0..1
  eyeSquint: number; // 0..1, average of cheekSquintLeft/Right
};

// Normalized [0..1] face box used only to draw the subtle tracking overlay.
export type FaceBox = { x: number; y: number; w: number; h: number };

export type FaceSample = {
  faceAvailable: boolean;
  features?: FaceFeatures;
  box?: FaceBox;
  mouthBox?: FaceBox; // tight box around the mouth, for occlusion checks
};

// One detected hand as normalized [0..1] points (used to spot a hand over the mouth).
export type HandPoint = { x: number; y: number };

export type LaughDetectorStatus = 'idle' | 'listening' | 'unavailable' | 'stopped';

// Coarse, honest labels only — this never claims to know a real emotion.
export type ExpressionLabel = 'no-face' | 'neutral' | 'smiling' | 'possible-laughter';
