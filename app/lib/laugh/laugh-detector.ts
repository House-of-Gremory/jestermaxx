import type { AudioFeatures, FaceFeatures, LaughEvent } from './types';

// Fused face + audio laugh detector (spec §7). A laugh is a temporal event, not a
// per-frame boolean: a candidate must last long enough, stay active enough, show
// real facial laughter cues, AND have audio energy before ONE event is emitted,
// followed by a cooldown.
//
// Competitive mode (face + audio present) is tight: a silent smile, a still open
// mouth, or a random noise on their own will not confirm. When the face signal is
// unavailable it falls back to an audio-only mode with stricter thresholds and
// lower trust, so scoring degrades instead of breaking.

const DETECTOR_VERSION = 'face-audio-v1';

// Tunables — starting points, calibrate on real devices (spec §12).
const CALIBRATION_MS = 800;
const CANDIDATE_MIN_MS = 450;
const CANDIDATE_MAX_MS = 4000;
const END_BELOW_MS = 350;
const COOLDOWN_MS = 2000;
const ENERGY_RATIO_TRIGGER = 2.2;
const EMA = 0.4;

// Face indicator thresholds (an "indicator" = one clear laughter cue).
const SMILE_ON = 0.55;
const JAW_ON = 0.25;
const SQUINT_ON = 0.2;

// Confirmation gates.
const FUSED_CONFIDENCE = 0.72;
const FUSED_ACTIVE_RATIO = 0.35;
const FUSED_FACE_INDICATORS = 2; // need >= 2 face cues at some point
const AUDIO_ONLY_CONFIDENCE = 0.7;
const AUDIO_ONLY_ACTIVE_RATIO = 0.45;

type State = 'QUIET' | 'POSSIBLE' | 'COOLDOWN';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export class LaughDetector {
  private state: State = 'QUIET';
  private startTs = 0;
  private calibrated = false;
  private noiseFloor = 1e-4;

  // smoothed features
  private sRms = 0;
  private sHigh = 0;
  private sZcr = 0;
  private prevRms = 0;
  private sSmile = 0;
  private sJaw = 0;
  private sSquint = 0;
  private prevJaw = 0;

  // candidate accumulators
  private candidateStart = 0;
  private belowSince = 0;
  private totalWindows = 0;
  private audioActiveWindows = 0;
  private combinedSum = 0;
  private audioSum = 0;
  private facePeakIndicators = 0;
  private faceSeen = false;

  reset() {
    this.state = 'QUIET';
    this.startTs = 0;
    this.calibrated = false;
    this.noiseFloor = 1e-4;
    this.sRms = this.sHigh = this.sZcr = this.prevRms = 0;
    this.sSmile = this.sJaw = this.sSquint = this.prevJaw = 0;
  }

  update(audio: AudioFeatures, face: FaceFeatures | null, now: number): LaughEvent | null {
    if (!this.startTs) this.startTs = now;

    // Smooth audio.
    this.sRms = this.sRms ? this.sRms * (1 - EMA) + audio.rms * EMA : audio.rms;
    this.sHigh = this.sHigh * (1 - EMA) + audio.highBandEnergy * EMA;
    this.sZcr = this.sZcr * (1 - EMA) + audio.zcr * EMA;

    // Smooth face (only when present; otherwise decay toward zero).
    if (face) {
      this.sSmile = this.sSmile * (1 - EMA) + face.smile * EMA;
      this.sJaw = this.sJaw * (1 - EMA) + face.jawOpen * EMA;
      this.sSquint = this.sSquint * (1 - EMA) + face.eyeSquint * EMA;
    } else {
      this.sSmile *= 0.8;
      this.sJaw *= 0.8;
      this.sSquint *= 0.8;
    }

    // Calibrate noise floor from the first ~800ms of quiet.
    if (!this.calibrated) {
      this.noiseFloor = Math.max(this.noiseFloor * 0.9 + this.sRms * 0.1, 1e-5);
      if (now - this.startTs >= CALIBRATION_MS) this.calibrated = true;
      return null;
    }
    if (this.sRms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.995 + this.sRms * 0.005;
    }

    // ---- per-window scores ----
    const energyRatio = this.sRms / Math.max(this.noiseFloor, 1e-6);
    const rmsDelta = Math.abs(this.sRms - this.prevRms);
    this.prevRms = this.sRms;

    const energyScore = clamp01((energyRatio - 1) / (ENERGY_RATIO_TRIGGER * 2));
    const highScore = clamp01(this.sHigh / 0.5);
    const zcrScore = clamp01((this.sZcr - 0.05) / 0.25);
    const rhythmScore = clamp01(rmsDelta / (this.noiseFloor * 3));
    const audioScore = clamp01(
      0.45 * energyScore + 0.2 * highScore + 0.15 * zcrScore + 0.2 * rhythmScore,
    );

    const jawDelta = Math.abs(this.sJaw - this.prevJaw);
    this.prevJaw = this.sJaw;
    const smileScore = clamp01((this.sSmile - 0.2) / 0.6);
    const mouthOpenScore = clamp01((this.sJaw - 0.15) / 0.5);
    const mouthActivityScore = clamp01(jawDelta / 0.1);
    const mouthScore = Math.max(mouthOpenScore * 0.7, mouthActivityScore);
    const squintScore = clamp01((this.sSquint - 0.1) / 0.4);
    const faceScore = clamp01(0.45 * smileScore + 0.35 * mouthScore + 0.2 * squintScore);

    const faceIndicators =
      (this.sSmile >= SMILE_ON ? 1 : 0) +
      (this.sJaw >= JAW_ON ? 1 : 0) +
      (this.sSquint >= SQUINT_ON ? 1 : 0);

    const hasFace = face !== null;
    const combinedScore = hasFace ? 0.55 * faceScore + 0.45 * audioScore : audioScore;
    const audioActive = energyRatio >= ENERGY_RATIO_TRIGGER;

    // ---- state machine ----
    if (this.state === 'COOLDOWN') {
      if (now - this.candidateStart >= COOLDOWN_MS) this.state = 'QUIET';
      return null;
    }

    if (this.state === 'QUIET') {
      // Start a candidate on audio energy plus (if a face is present) an actual
      // smile forming — this is what keeps a silent smile from starting one.
      const faceGate = hasFace ? this.sSmile >= 0.4 : audioScore > 0.35;
      if (audioActive && faceGate) {
        this.state = 'POSSIBLE';
        this.candidateStart = now;
        this.belowSince = 0;
        this.totalWindows = 1;
        this.audioActiveWindows = 1;
        this.combinedSum = combinedScore;
        this.audioSum = audioScore;
        this.facePeakIndicators = faceIndicators;
        this.faceSeen = hasFace;
      }
      return null;
    }

    // POSSIBLE
    this.totalWindows += 1;
    this.combinedSum += combinedScore;
    this.audioSum += audioScore;
    if (hasFace) this.faceSeen = true;
    if (faceIndicators > this.facePeakIndicators) this.facePeakIndicators = faceIndicators;
    if (audioActive) {
      this.audioActiveWindows += 1;
      this.belowSince = 0;
    } else if (!this.belowSince) {
      this.belowSince = now;
    }

    const duration = now - this.candidateStart;
    const endedQuiet = this.belowSince > 0 && now - this.belowSince >= END_BELOW_MS;
    const tooLong = duration > CANDIDATE_MAX_MS;
    if (!endedQuiet && !tooLong) return null;

    // Candidate finished — decide, then cooldown regardless.
    const activeRatio = this.audioActiveWindows / Math.max(1, this.totalWindows);
    const avgCombined = this.combinedSum / Math.max(1, this.totalWindows);
    const avgAudio = this.audioSum / Math.max(1, this.totalWindows);
    const durationOk = duration >= CANDIDATE_MIN_MS && duration <= CANDIDATE_MAX_MS;

    const confirmed = this.faceSeen
      ? durationOk &&
        activeRatio >= FUSED_ACTIVE_RATIO &&
        this.facePeakIndicators >= FUSED_FACE_INDICATORS &&
        avgCombined >= FUSED_CONFIDENCE
      : durationOk && activeRatio >= AUDIO_ONLY_ACTIVE_RATIO && avgAudio >= AUDIO_ONLY_CONFIDENCE;

    this.state = 'COOLDOWN';
    this.candidateStart = now; // reuse as cooldown start

    if (!confirmed) return null;
    return {
      clientEventId: crypto.randomUUID(),
      occurredAt: Date.now(),
      durationMs: Math.round(duration),
      confidence: Math.round((this.faceSeen ? avgCombined : avgAudio) * 100) / 100,
      detectorVersion: DETECTOR_VERSION,
    };
  }
}
