import type { AudioFeatures, ExpressionLabel, FaceFeatures, LaughEvent, ScoreReason } from './types';

// Fused face + audio laugh/smile detector, tuned to fire on real smiles and
// laughs while resisting false positives.
//
// Smile scoring uses a HYSTERESIS state (a Schmitt trigger), not a fixed hold:
//  - Smile turns ON when the smoothed smile crosses SMILE_ON.
//  - It stays ON through brief dips/head movement, and only turns OFF after the
//    smile stays below SMILE_OFF continuously for SMILE_CLEAR_MS (~2s).
// This matches real behaviour (nobody holds a frozen grin) and stops the
// neutral<->smile flicker. Each smile turning ON awards a light 0.5 point once;
// a full laugh (smile + open jaw / squint / audio bursts) adds 1 on top.

const DETECTOR_VERSION = 'face-audio-v4';

const CALIBRATION_MS = 700;
const CANDIDATE_MIN_MS = 400;
const CANDIDATE_MAX_MS = 5000;
const END_BELOW_MS = 400;
const COOLDOWN_MS = 1500; // min gap between LAUGH awards
const ENERGY_RATIO_TRIGGER = 2.0;
const AUDIO_EMA = 0.4;
const FACE_EMA = 0.3; // heavier smoothing on face -> steadier smile signal

const JAW_ON = 0.22;

// Smile hysteresis.
const SMILE_ON = 0.42; // turn smiling ON
const SMILE_OFF = 0.28; // must drop below this...
const SMILE_CLEAR_MS = 2000; // ...for this long before smiling turns OFF
const SMILE_POINTS = 0.5;

// Laugh confirmation. A real laugh shows SEVERAL things at once — an open jaw,
// cheek/eye squint, and audible rhythmic bursts — whereas a plain smile or a
// stray noise shows at most one. Requiring two independent cues (rather than
// any single one) is what separates laughter from both.
const SMILE_PEAK_MIN = 0.5;
const JAW_CUE = 0.22;
const SQUINT_CUE = 0.25;
const BURST_CUE = 2;
const MIN_CUES = 2; // how many of {jaw, squint, audio bursts} must be present
const MIN_FACE_PRESENCE = 0.5;
const CONFIRM_CONFIDENCE = 0.52;
const LAUGH_POINTS = 1;

type State = 'QUIET' | 'POSSIBLE';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export type DetectorTick = {
  event: LaughEvent | null;
  expression: ExpressionLabel;
  smiling: boolean;
};

export class LaughDetector {
  private state: State = 'QUIET';
  private startTs = 0;
  private calibrated = false;
  private noiseFloor = 1e-4;
  private cooldownUntil = 0;

  private sRms = 0;
  private sHigh = 0;
  private sSmile = 0;
  private sJaw = 0;
  private sSquint = 0;
  private prevActive = false;

  // smile hysteresis state
  private smiling = false;
  private neutralSince = 0;

  // laugh candidate accumulators
  private candidateStart = 0;
  private belowSince = 0;
  private totalWindows = 0;
  private faceWindows = 0;
  private combinedSum = 0;
  private bursts = 0;
  private smilePeak = 0;
  private jawPeak = 0;
  private squintPeak = 0;

  reset() {
    this.state = 'QUIET';
    this.startTs = 0;
    this.calibrated = false;
    this.noiseFloor = 1e-4;
    this.cooldownUntil = 0;
    this.sRms = this.sHigh = 0;
    this.sSmile = this.sJaw = this.sSquint = 0;
    this.prevActive = false;
    this.smiling = false;
    this.neutralSince = 0;
  }

  private makeEvent(reason: ScoreReason, points: number, durationMs: number, confidence: number): LaughEvent {
    return {
      clientEventId: crypto.randomUUID(),
      occurredAt: Date.now(),
      durationMs: Math.round(durationMs),
      confidence: Math.round(confidence * 100) / 100,
      detectorVersion: DETECTOR_VERSION,
      reason,
      points,
    };
  }

  private expressionFor(hasFace: boolean, audioActive: boolean): ExpressionLabel {
    if (!hasFace) return 'no-face';
    if (!this.smiling) return 'neutral';
    if (this.sJaw >= JAW_ON || audioActive) return 'possible-laughter';
    return 'smiling';
  }

  update(audio: AudioFeatures, face: FaceFeatures | null, now: number): DetectorTick {
    if (!this.startTs) this.startTs = now;

    this.sRms = this.sRms ? this.sRms * (1 - AUDIO_EMA) + audio.rms * AUDIO_EMA : audio.rms;
    this.sHigh = this.sHigh * (1 - AUDIO_EMA) + audio.highBandEnergy * AUDIO_EMA;
    if (face) {
      this.sSmile = this.sSmile * (1 - FACE_EMA) + face.smile * FACE_EMA;
      this.sJaw = this.sJaw * (1 - FACE_EMA) + face.jawOpen * FACE_EMA;
      this.sSquint = this.sSquint * (1 - FACE_EMA) + face.eyeSquint * FACE_EMA;
    } else {
      this.sSmile *= 0.85;
      this.sJaw *= 0.85;
      this.sSquint *= 0.85;
    }

    const hasFace = face !== null;

    if (!this.calibrated) {
      this.noiseFloor = Math.max(this.noiseFloor * 0.9 + this.sRms * 0.1, 1e-5);
      if (now - this.startTs >= CALIBRATION_MS) this.calibrated = true;
      return { event: null, expression: this.expressionFor(hasFace, false), smiling: this.smiling };
    }
    if (this.sRms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.995 + this.sRms * 0.005;
    }

    const energyRatio = this.sRms / Math.max(this.noiseFloor, 1e-6);
    const audioActive = energyRatio >= ENERGY_RATIO_TRIGGER;
    const risingEdge = audioActive && !this.prevActive;
    this.prevActive = audioActive;

    // ---- Smile hysteresis (independent of the laugh machine) ----
    let smileEvent: LaughEvent | null = null;
    if (hasFace) {
      if (!this.smiling) {
        if (this.sSmile >= SMILE_ON) {
          this.smiling = true;
          this.neutralSince = 0;
          smileEvent = this.makeEvent('smile', SMILE_POINTS, 0, this.sSmile);
        }
      } else {
        // Currently smiling: only clear after a sustained drop to neutral.
        if (this.sSmile < SMILE_OFF) {
          if (!this.neutralSince) this.neutralSince = now;
          else if (now - this.neutralSince >= SMILE_CLEAR_MS) {
            this.smiling = false;
            this.neutralSince = 0;
          }
        } else {
          this.neutralSince = 0;
        }
      }
    } else {
      // Face gone: relax smile state (but don't count it as neutral cheating —
      // face-absence is handled by the hook's timeout penalty).
      this.smiling = false;
      this.neutralSince = 0;
    }

    const expression = this.expressionFor(hasFace, audioActive);

    // A smile onset always reports (a laugh may also confirm below and add more).
    // ---- Laugh state machine ----
    const smileScore = clamp01((this.sSmile - 0.2) / 0.6);
    const mouthScore = clamp01((this.sJaw - 0.12) / 0.5);
    const squintScore = clamp01((this.sSquint - 0.1) / 0.4);
    const faceScore = clamp01(0.5 * smileScore + 0.3 * mouthScore + 0.2 * squintScore);
    const audioScore =
      clamp01((energyRatio - 1) / (ENERGY_RATIO_TRIGGER * 2)) * 0.6 + clamp01(this.sHigh / 0.5) * 0.4;
    const combinedScore = hasFace ? clamp01(0.7 * faceScore + 0.3 * audioScore) : 0;

    const inCooldown = now < this.cooldownUntil;

    if (this.state === 'QUIET') {
      if (!inCooldown && hasFace && this.sSmile >= 0.3) {
        this.state = 'POSSIBLE';
        this.candidateStart = now;
        this.belowSince = 0;
        this.totalWindows = 1;
        this.faceWindows = 1;
        this.combinedSum = combinedScore;
        this.bursts = audioActive ? 1 : 0;
        this.smilePeak = this.sSmile;
        this.jawPeak = this.sJaw;
        this.squintPeak = this.sSquint;
      }
      return { event: smileEvent, expression, smiling: this.smiling };
    }

    // POSSIBLE
    this.totalWindows += 1;
    this.combinedSum += combinedScore;
    if (hasFace) this.faceWindows += 1;
    if (risingEdge) this.bursts += 1;
    if (this.sSmile > this.smilePeak) this.smilePeak = this.sSmile;
    if (this.sJaw > this.jawPeak) this.jawPeak = this.sJaw;
    if (this.sSquint > this.squintPeak) this.squintPeak = this.sSquint;

    const smilingWindow = this.sSmile >= SMILE_OFF;
    if (smilingWindow) this.belowSince = 0;
    else if (!this.belowSince) this.belowSince = now;

    const duration = now - this.candidateStart;
    const endedQuiet = this.belowSince > 0 && now - this.belowSince >= END_BELOW_MS;
    if (!endedQuiet && duration <= CANDIDATE_MAX_MS) {
      return { event: smileEvent, expression, smiling: this.smiling };
    }

    const facePresence = this.faceWindows / Math.max(1, this.totalWindows);
    const avgCombined = this.combinedSum / Math.max(1, this.totalWindows);
    // Count independent corroborating cues instead of accepting any single one.
    const cueCount =
      (this.jawPeak >= JAW_CUE ? 1 : 0) +
      (this.squintPeak >= SQUINT_CUE ? 1 : 0) +
      (this.bursts >= BURST_CUE ? 1 : 0);
    const hasCue = cueCount >= MIN_CUES;
    const confirmed =
      duration >= CANDIDATE_MIN_MS &&
      duration <= CANDIDATE_MAX_MS &&
      facePresence >= MIN_FACE_PRESENCE &&
      this.smilePeak >= SMILE_PEAK_MIN &&
      hasCue &&
      avgCombined >= CONFIRM_CONFIDENCE;

    this.state = 'QUIET';
    if (!confirmed) return { event: smileEvent, expression, smiling: this.smiling };

    this.cooldownUntil = now + COOLDOWN_MS;
    // A laugh outranks a coincident smile onset in the same tick.
    return {
      event: this.makeEvent('laugh', LAUGH_POINTS, duration, avgCombined),
      expression,
      smiling: this.smiling,
    };
  }
}
