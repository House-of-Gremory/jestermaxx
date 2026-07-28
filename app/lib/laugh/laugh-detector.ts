import type { AudioFeatures, LaughEvent } from './types';

// Audio-only laugh detector. This is the spec's "lower-confidence single-modality
// mode" (§7): face analysis is intentionally omitted to keep the bundle light and
// the loop cheap. The public shape (update -> optional LaughEvent) is stable, so a
// face/ML signal can be fused in later without changing callers.
//
// It is a temporal state machine, NOT a per-frame boolean: a candidate must last
// long enough, stay active enough, and average high enough confidence before one
// (and only one) event is emitted, followed by a cooldown.

const DETECTOR_VERSION = 'audio-v1';

// Tunables — starting points, meant to be calibrated on real devices (spec §12).
const CALIBRATION_MS = 800; // learn the room noise floor before detecting
const CANDIDATE_MIN_MS = 450;
const CANDIDATE_MAX_MS = 4000;
const END_BELOW_MS = 350; // silence this long ends a candidate
const COOLDOWN_MS = 2000; // one long laugh cannot become many points
const ENERGY_RATIO_TRIGGER = 2.2; // loudness vs noise floor to count as "active"
const ACTIVE_RATIO_MIN = 0.35; // fraction of the candidate that must be active
const CONFIRM_CONFIDENCE = 0.62; // avg per-window score needed to confirm
const EMA = 0.4; // feature smoothing factor

type State = 'QUIET' | 'POSSIBLE' | 'COOLDOWN';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export class LaughDetector {
  private state: State = 'QUIET';
  private startTs = 0;
  private calibrated = false;
  private noiseFloor = 1e-4;

  private sRms = 0;
  private sHigh = 0;
  private sZcr = 0;
  private prevRms = 0;

  private candidateStart = 0;
  private belowSince = 0;
  private activeWindows = 0;
  private totalWindows = 0;
  private confSum = 0;

  reset() {
    this.state = 'QUIET';
    this.startTs = 0;
    this.calibrated = false;
    this.noiseFloor = 1e-4;
    this.sRms = 0;
    this.sHigh = 0;
    this.sZcr = 0;
    this.prevRms = 0;
  }

  // Feed one analysis window. `now` is a monotonic ms timestamp (performance.now
  // via requestAnimationFrame). Returns a LaughEvent exactly once per confirmed
  // laugh, otherwise null.
  update(f: AudioFeatures, now: number): LaughEvent | null {
    if (!this.startTs) this.startTs = now;

    this.sRms = this.sRms ? this.sRms * (1 - EMA) + f.rms * EMA : f.rms;
    this.sHigh = this.sHigh * (1 - EMA) + f.highBandEnergy * EMA;
    this.sZcr = this.sZcr * (1 - EMA) + f.zcr * EMA;

    // Calibrate the noise floor from the first ~800ms of quiet.
    if (!this.calibrated) {
      this.noiseFloor = Math.max(this.noiseFloor * 0.9 + this.sRms * 0.1, 1e-5);
      if (now - this.startTs >= CALIBRATION_MS) this.calibrated = true;
      return null;
    }

    // Slowly track the floor upward/downward while quiet so it adapts to the room.
    if (this.sRms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.995 + this.sRms * 0.005;
    }

    const energyRatio = this.sRms / Math.max(this.noiseFloor, 1e-6);
    const rmsDelta = Math.abs(this.sRms - this.prevRms);
    this.prevRms = this.sRms;

    // Per-window confidence from loudness, brightness, noisiness, and modulation
    // (laughter is loud, breathy/bright, noisy, and bursty rather than steady).
    const energyScore = clamp01((energyRatio - 1) / (ENERGY_RATIO_TRIGGER * 2));
    const highScore = clamp01(this.sHigh / 0.5);
    const zcrScore = clamp01((this.sZcr - 0.05) / 0.25);
    const rhythmScore = clamp01(rmsDelta / (this.noiseFloor * 3));
    const audioScore = clamp01(
      0.45 * energyScore + 0.2 * highScore + 0.15 * zcrScore + 0.2 * rhythmScore,
    );

    const active = energyRatio >= ENERGY_RATIO_TRIGGER;

    if (this.state === 'COOLDOWN') {
      if (now - this.candidateStart >= COOLDOWN_MS) this.state = 'QUIET';
      return null;
    }

    if (this.state === 'QUIET') {
      if (active && audioScore > 0.35) {
        this.state = 'POSSIBLE';
        this.candidateStart = now;
        this.belowSince = 0;
        this.activeWindows = 1;
        this.totalWindows = 1;
        this.confSum = audioScore;
      }
      return null;
    }

    // POSSIBLE
    this.totalWindows += 1;
    this.confSum += audioScore;
    if (active) {
      this.activeWindows += 1;
      this.belowSince = 0;
    } else if (!this.belowSince) {
      this.belowSince = now;
    }

    const duration = now - this.candidateStart;
    const endedQuiet = this.belowSince > 0 && now - this.belowSince >= END_BELOW_MS;
    const tooLong = duration > CANDIDATE_MAX_MS;
    if (!endedQuiet && !tooLong) return null;

    // Candidate finished — decide and enter cooldown regardless.
    const activeRatio = this.activeWindows / Math.max(1, this.totalWindows);
    const avgConfidence = this.confSum / Math.max(1, this.totalWindows);
    const confirmed =
      duration >= CANDIDATE_MIN_MS &&
      duration <= CANDIDATE_MAX_MS &&
      activeRatio >= ACTIVE_RATIO_MIN &&
      avgConfidence >= CONFIRM_CONFIDENCE;

    this.state = 'COOLDOWN';
    this.candidateStart = now; // reuse as cooldown start

    if (!confirmed) return null;
    return {
      clientEventId: crypto.randomUUID(),
      occurredAt: Date.now(),
      durationMs: Math.round(duration),
      confidence: Math.round(avgConfidence * 100) / 100,
      detectorVersion: DETECTOR_VERSION,
    };
  }
}
