// Wraps the pitch-shift AudioWorklet into a drop-in replacement for the local
// microphone track. The processed track is swapped onto the outgoing WebRTC
// sender, so only the OPPONENT hears the effect — nothing about our own audio
// analysis (the laugh detector reads the raw mic stream) changes.
export class VoiceFilter {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  // Builds the graph and returns the processed audio track, or null when the
  // browser has no usable audio track / AudioWorklet support.
  async start(stream: MediaStream): Promise<MediaStreamTrack | null> {
    if (stream.getAudioTracks().length === 0) return null;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    this.ctx = ctx;

    await ctx.audioWorklet.addModule('/pitch-shift-processor.js');
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});

    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'pitch-shift-processor');
    this.dest = ctx.createMediaStreamDestination();

    // Deliberately NOT connected to ctx.destination — that would play our own
    // pitched voice back into our speakers and feed the mic.
    this.source.connect(this.node);
    this.node.connect(this.dest);

    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  stop() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.dest?.disconnect();
    } catch {
      // already torn down
    }
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.dest = null;
  }
}
