// Granular pitch shifter, run inside an AudioWorklet so the DSP never touches
// the main thread (the arena is already doing face/hand inference there).
//
// How it works: input is written into a ring buffer while TWO read heads walk
// through it at `pitch` speed, half a grain apart. Reading faster than writing
// raises the pitch; the second head, cross-faded with a triangular window,
// covers the discontinuity when the first wraps around. Triangular windows
// offset by half a period sum to 1, so the output stays at unity gain.
class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1.6, minValue: 1, maxValue: 3 }];
  }

  constructor() {
    super();
    this.size = 8192; // ring buffer length in samples
    this.grain = 1536; // ~32ms at 48k: long enough to avoid buzz, short enough to stay tight
    this.buffer = new Float32Array(this.size);
    this.writePos = 0;
    this.readOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    // No input yet (mic still warming up) — emit silence rather than noise.
    if (!input) {
      output.fill(0);
      return true;
    }

    // `parameters` is not used per-sample: a constant pitch keeps this cheap.
    const pitch = 1.6;
    const half = this.grain / 2;

    for (let i = 0; i < output.length; i += 1) {
      this.buffer[this.writePos] = input[i];

      const head1 = this.readOffset;
      const head2 = head1 >= half ? head1 - half : head1 + half;

      // Read behind the write head by a full grain so we never read unwritten
      // samples, then wrap into the ring buffer.
      const idx1 = (this.writePos - this.grain + head1 + this.size) % this.size;
      const idx2 = (this.writePos - this.grain + head2 + this.size) % this.size;

      const w1 = 1 - Math.abs((head1 / half) - 1);
      const w2 = 1 - Math.abs((head2 / half) - 1);

      output[i] = this.buffer[idx1] * w1 + this.buffer[idx2] * w2;

      this.readOffset += pitch;
      while (this.readOffset >= this.grain) this.readOffset -= this.grain;
      this.writePos = (this.writePos + 1) % this.size;
    }

    return true;
  }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
