// Shared types for the laugh-detection pipeline. Kept deliberately small: the
// heavy per-frame feature data lives in class instances/refs, never in React
// state or on the wire. Only a confirmed LaughEvent ever leaves the detector.

export type AudioFeatures = {
  rms: number; // overall loudness / energy of the window
  zcr: number; // zero-crossing rate 0..1 (noisiness)
  centroid: number; // spectral centroid 0..1 (brightness)
  highBandEnergy: number; // 0..1 share of energy above the voice fundamental
};

// The only object that crosses a boundary (to the opponent / a future server).
// No media, no landmarks, no feature arrays — see LAUGH-DETECTION spec §8.
export type LaughEvent = {
  clientEventId: string;
  occurredAt: number;
  durationMs: number;
  confidence: number;
  detectorVersion: string;
};

export type LaughDetectorStatus = 'idle' | 'listening' | 'unavailable' | 'stopped';
