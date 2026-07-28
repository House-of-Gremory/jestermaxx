import type { AudioFeatures } from './types';

// Wraps a single AudioContext + AnalyserNode over the local microphone track.
// Extremely cheap: reads two fixed buffers per call and does one pass of math.
// The source is connected ONLY to the analyser, never to ctx.destination, so the
// participant never hears their own mic (spec §4.4). Buffers are reused every
// call — no per-frame allocations.
export class AudioAnalyzer {
  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private timeBuf: Float32Array<ArrayBuffer>;
  private freqBuf: Float32Array<ArrayBuffer>;

  constructor(stream: MediaStream) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this.source.connect(this.analyser);
    this.timeBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.freqBuf = new Float32Array(new ArrayBuffer(this.analyser.frequencyBinCount * 4));
  }

  async resume() {
    // Browsers may start the context suspended until a user gesture; the "Enter
    // the Arena" click satisfies that, so this normally resolves immediately.
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // Left suspended -> getFeatures returns near-zero -> no false laughs.
      }
    }
  }

  getFeatures(): AudioFeatures {
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    this.analyser.getFloatFrequencyData(this.freqBuf);

    // Time domain: RMS energy + zero-crossing rate.
    let sumSq = 0;
    let crossings = 0;
    for (let i = 0; i < this.timeBuf.length; i += 1) {
      const s = this.timeBuf[i];
      sumSq += s * s;
      if (i > 0 && s >= 0 !== this.timeBuf[i - 1] >= 0) crossings += 1;
    }
    const rms = Math.sqrt(sumSq / this.timeBuf.length);
    const zcr = crossings / this.timeBuf.length;

    // Frequency domain (dBFS -> linear magnitude): spectral centroid + share of
    // energy above the typical voice fundamental (laughter is breathy/bright).
    const bins = this.freqBuf.length;
    const nyquist = this.ctx.sampleRate / 2;
    const highCutHz = 1500;
    let magSum = 0;
    let weighted = 0;
    let highEnergy = 0;
    for (let i = 0; i < bins; i += 1) {
      const mag = Math.pow(10, this.freqBuf[i] / 20);
      const freq = (i / bins) * nyquist;
      magSum += mag;
      weighted += mag * freq;
      if (freq >= highCutHz) highEnergy += mag;
    }
    const centroid = magSum > 0 ? Math.min(1, weighted / magSum / nyquist) : 0;
    const highBandEnergy = magSum > 0 ? highEnergy / magSum : 0;

    return { rms, zcr, centroid, highBandEnergy };
  }

  close() {
    try {
      this.source.disconnect();
      this.analyser.disconnect();
    } catch {
      // already disconnected
    }
    if (this.ctx.state !== 'closed') void this.ctx.close();
  }
}
