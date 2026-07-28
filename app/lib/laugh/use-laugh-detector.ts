'use client';

import { useEffect, useRef, useState } from 'react';
import { AudioAnalyzer } from './audio-analyzer';
import { LaughDetector } from './laugh-detector';
import type { LaughDetectorStatus, LaughEvent } from './types';

// ~30 Hz analysis. Audio windows are tiny and cheap; this never touches the
// WebRTC signaling loop and does not allocate per frame.
const FRAME_MS = 33;

// Drives the audio laugh detector off an existing local MediaStream. Returns
// only high-level state so React re-renders a handful of times per session, not
// per frame. A confirmed laugh calls `onLaugh` (kept in a ref so changing the
// callback never restarts the audio graph).
export function useLaughDetector({
  stream,
  enabled,
  onLaugh,
}: {
  stream: MediaStream | null;
  enabled: boolean;
  onLaugh?: (event: LaughEvent) => void;
}): { status: LaughDetectorStatus; recentLaugh: boolean } {
  const [status, setStatus] = useState<LaughDetectorStatus>('idle');
  const [recentLaugh, setRecentLaugh] = useState(false);

  // Keep the latest callback without re-running the audio-setup effect.
  const onLaughRef = useRef(onLaugh);
  useEffect(() => {
    onLaughRef.current = onLaugh;
  });

  useEffect(() => {
    const hasAudio = Boolean(enabled && stream && stream.getAudioTracks().length > 0);
    let cancelled = false;

    if (!hasAudio) {
      const idle: LaughDetectorStatus = enabled && stream ? 'unavailable' : 'idle';
      // Deferred so this isn't a synchronous setState inside the effect body.
      const timer = setTimeout(() => {
        if (!cancelled) setStatus(idle);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    const activeStream = stream as MediaStream;
    let analyzer: AudioAnalyzer | null = null;
    const detector = new LaughDetector();
    let rafId = 0;
    let last = 0;
    let announced = false;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const loop = (t: number) => {
      rafId = requestAnimationFrame(loop);
      if (t - last < FRAME_MS || !analyzer) return;
      last = t;
      if (document.hidden) return; // pause detection when the tab is hidden
      if (!announced) {
        announced = true;
        setStatus('listening');
      }

      const event = detector.update(analyzer.getFeatures(), t);
      if (event) {
        setRecentLaugh(true);
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => setRecentLaugh(false), 1200);
        onLaughRef.current?.(event);
      }
    };

    (async () => {
      try {
        analyzer = new AudioAnalyzer(activeStream);
        await analyzer.resume();
        if (cancelled) {
          analyzer.close();
          analyzer = null;
          return;
        }
        rafId = requestAnimationFrame(loop);
      } catch (error) {
        console.error('Laugh detector failed to start', error);
        if (!cancelled) setStatus('unavailable');
      }
    })();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (flashTimer) clearTimeout(flashTimer);
      analyzer?.close();
      setRecentLaugh(false);
      setStatus('stopped');
    };
  }, [stream, enabled]);

  return { status, recentLaugh };
}
