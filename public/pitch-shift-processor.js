// Granular pitch shifter, run inside an AudioWorklet so the DSP never touches
// the main thread (the arena is already doing face/hand inference there).
//
// How it works: input is written into a ring buffer while TWO read heads walk
// through it at `pitch` speed, half a grain apart. Reading faster than writing
// raises the pitch; the second head, cross-faded with a triangular window,
// covers the discontinuity when the first wraps around. Triangular windows
// offset by half a period sum to 1, so the output stays at unity gain.
//
// The read heads sit at FRACTIONAL positions, so samples are linearly
// interpolated between the two neighbouring integer slots. Indexing a
// Float32Array with a fractional index yields `undefined` (and then NaN, which
// plays as silence), so the floor/frac split below is required, not cosmetic.
const PITCH = 1.6; // >1 raises pitch; 1.4 is mild, 2.0 is extreme
const RING_SIZE = 8192;
const GRAIN = 1536; // ~32ms at 48k: long enough to avoid buzz, short enough to stay tight

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(RING_SIZE);
    this.writePos = 0;
    this.readOffset = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const input = inputs[0] && inputs[0][0];
    if (!input) {
      // Mic not delivering yet — emit silence rather than garbage.
      for (const channel of output) channel.fill(0);
      return true;
    }

    const half = GRAIN / 2;
    const frames = output[0].length;

    for (let i = 0; i < frames; i += 1) {
      this.buffer[this.writePos] = input[i];

      const head1 = this.readOffset;
      const head2 = head1 >= half ? head1 - half : head1 + half;

      // Read a full grain behind the write head so we never read samples that
      // have not been written yet, then wrap into the ring.
      const pos1 = (this.writePos - GRAIN + head1 + RING_SIZE) % RING_SIZE;
      const pos2 = (this.writePos - GRAIN + head2 + RING_SIZE) % RING_SIZE;

      const i1 = Math.floor(pos1);
      const f1 = pos1 - i1;
      const s1 =
        this.buffer[i1] * (1 - f1) + this.buffer[(i1 + 1) % RING_SIZE] * f1;

      const i2 = Math.floor(pos2);
      const f2 = pos2 - i2;
      const s2 =
        this.buffer[i2] * (1 - f2) + this.buffer[(i2 + 1) % RING_SIZE] * f2;

      // Triangular cross-fade; the two windows sum to 1 at every position.
      const w1 = 1 - Math.abs(head1 / half - 1);
      const w2 = 1 - Math.abs(head2 / half - 1);

      const sample = s1 * w1 + s2 * w2;
      // Belt and braces: never let a non-finite value reach the output.
      const safe = Number.isFinite(sample) ? sample : 0;

      // Mono result, copied to every output channel.
      for (let c = 0; c < output.length; c += 1) output[c][i] = safe;

      // The read position is measured relative to writePos, which itself moves
      // one sample per frame — so the offset must advance by PITCH - 1 for the
      // combined read rate to come out at exactly PITCH.
      this.readOffset += PITCH - 1;
      while (this.readOffset >= GRAIN) this.readOffset -= GRAIN;
      while (this.readOffset < 0) this.readOffset += GRAIN;
      this.writePos = (this.writePos + 1) % RING_SIZE;
    }

    return true;
  }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
