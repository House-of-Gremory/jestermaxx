'use client';

import { type RefObject, useEffect, useRef, useState } from 'react';
import { AudioAnalyzer } from './audio-analyzer';
import { FaceDetector } from './face-detector';
import { HandDetector } from './hand-detector';
import { LaughDetector } from './laugh-detector';
import type {
  ExpressionLabel,
  FaceBox,
  FaceSample,
  HandPoint,
  LaughDetectorStatus,
  LaughEvent,
} from './types';

const AUDIO_FRAME_MS = 33; // ~30 Hz audio analysis
const FACE_FRAME_MS = 120; // ~8 Hz face inference (heavier; light + spec §16)
const HAND_FRAME_MS = 160; // ~6 Hz hand inference (only for mouth-cover check)
const EXPRESSION_THROTTLE_MS = 200; // limit expression re-renders to ~5 Hz
const FACE_TIMEOUT_MS = 12_000; // no face this long -> fairness penalty
const PENALTY_POINTS = 3; // points to the opponent when you hide your face

// Anti-cheat: a hand held over the mouth to muffle laughs. Set to false to skip
// loading the hand model entirely (lighter) if you don't want this check.
const DETECT_MOUTH_COVER = true;
const MOUTH_COVER_MS = 4000; // hand over mouth this long -> penalty
const MOUTH_COVER_POINTS = 2;

function pointInBox(p: HandPoint, box: FaceBox): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

// Drives the fused laugh detector off the existing local media. Audio runs every
// frame; face inference runs at a lower rate and its latest sample is reused by
// the audio loop, so the two never block each other. Per-frame data stays in
// refs — React re-renders only on status/face/laugh changes, not per frame.
export function useLaughDetector({
  stream,
  videoRef,
  overlayRef,
  enabled,
  onLaugh,
}: {
  stream: MediaStream | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  enabled: boolean;
  onLaugh?: (event: LaughEvent) => void;
}): {
  status: LaughDetectorStatus;
  recentLaugh: boolean;
  faceAvailable: boolean;
  expression: ExpressionLabel;
} {
  const [status, setStatus] = useState<LaughDetectorStatus>('idle');
  const [recentLaugh, setRecentLaugh] = useState(false);
  const [faceAvailable, setFaceAvailable] = useState(false);
  const [expression, setExpression] = useState<ExpressionLabel>('no-face');

  const onLaughRef = useRef(onLaugh);
  useEffect(() => {
    onLaughRef.current = onLaugh;
  });

  useEffect(() => {
    const hasAudio = Boolean(enabled && stream && stream.getAudioTracks().length > 0);
    let cancelled = false;

    if (!hasAudio) {
      const idle: LaughDetectorStatus = enabled && stream ? 'unavailable' : 'idle';
      const timer = setTimeout(() => {
        if (!cancelled) setStatus(idle);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    const activeStream = stream as MediaStream;
    const hasVideo = activeStream.getVideoTracks().length > 0;
    const overlayCanvas = overlayRef.current; // captured for cleanup
    const detector = new LaughDetector();
    const faceDetector = new FaceDetector();
    const handDetector = new HandDetector();
    let analyzer: AudioAnalyzer | null = null;

    let rafId = 0;
    let lastAudio = 0;
    let lastFace = 0;
    let lastHand = 0;
    let announced = false;
    let latestFace: FaceSample | null = null;
    let faceFlag = false;
    let lastFaceSeenAt = 0; // 0 until the model is ready and monitoring starts
    let penalized = false;
    let coverSince = 0;
    let mouthPenalized = false;
    let lastExprAt = 0;
    let lastExpr: ExpressionLabel | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const drawOverlay = (box?: FaceBox) => {
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const w = video.clientWidth;
      const h = video.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!box) return;

      // Subtle corner brackets around the tracked face — only drawn while a face
      // is actually detected, so the overlay appears only when tracking.
      const x = box.x * w;
      const y = box.y * h;
      const bw = box.w * w;
      const bh = box.h * h;
      const len = Math.min(bw, bh) * 0.22;
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.65)';
      ctx.lineWidth = 2;
      const corners: Array<[number, number, number, number]> = [
        [x, y, 1, 1],
        [x + bw, y, -1, 1],
        [x, y + bh, 1, -1],
        [x + bw, y + bh, -1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * len);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * len, cy);
        ctx.stroke();
      }
    };

    const loop = (t: number) => {
      rafId = requestAnimationFrame(loop);
      if (document.hidden) return;

      // Face inference (throttled) refreshes the shared sample + overlay.
      if (faceDetector.ready && t - lastFace >= FACE_FRAME_MS && videoRef.current) {
        lastFace = t;
        if (lastFaceSeenAt === 0) lastFaceSeenAt = t; // start monitoring once ready
        const sample = faceDetector.detect(videoRef.current, t);
        if (sample) {
          latestFace = sample;
          drawOverlay(sample.faceAvailable ? sample.box : undefined);
          if (sample.faceAvailable) {
            lastFaceSeenAt = t;
            penalized = false;
          }
          if (sample.faceAvailable !== faceFlag) {
            faceFlag = sample.faceAvailable;
            setFaceAvailable(faceFlag);
          }
        }
        // Fairness: face hidden too long -> award penalty points to the opponent
        // (once, until the face returns). Discourages hiding to avoid laughing.
        if (!penalized && t - lastFaceSeenAt >= FACE_TIMEOUT_MS) {
          penalized = true;
          onLaughRef.current?.({
            clientEventId: crypto.randomUUID(),
            occurredAt: Date.now(),
            durationMs: FACE_TIMEOUT_MS,
            confidence: 1,
            detectorVersion: 'face-timeout',
            reason: 'face-timeout',
            points: PENALTY_POINTS,
          });
        }
      }

      // Hand inference (low rate) — only to catch a hand held over the mouth to
      // muffle laughs. Uses the mouth box from the latest face sample.
      if (DETECT_MOUTH_COVER && handDetector.ready && t - lastHand >= HAND_FRAME_MS && videoRef.current) {
        lastHand = t;
        const hands = handDetector.detect(videoRef.current, t);
        const mouthBox = latestFace?.faceAvailable ? latestFace.mouthBox : undefined;
        if (hands && mouthBox) {
          const covered = hands.some((hand) => hand.some((p) => pointInBox(p, mouthBox)));
          if (covered) {
            if (!coverSince) coverSince = t;
            else if (!mouthPenalized && t - coverSince >= MOUTH_COVER_MS) {
              mouthPenalized = true;
              onLaughRef.current?.({
                clientEventId: crypto.randomUUID(),
                occurredAt: Date.now(),
                durationMs: MOUTH_COVER_MS,
                confidence: 1,
                detectorVersion: 'mouth-cover',
                reason: 'mouth-cover',
                points: MOUTH_COVER_POINTS,
              });
            }
          } else {
            coverSince = 0;
            mouthPenalized = false;
          }
        }
      }

      // Audio analysis every frame drives the detector, fusing the latest face.
      if (analyzer && t - lastAudio >= AUDIO_FRAME_MS) {
        lastAudio = t;
        if (!announced) {
          announced = true;
          setStatus('listening');
        }
        const face = latestFace?.faceAvailable ? (latestFace.features ?? null) : null;
        const tick = detector.update(analyzer.getFeatures(), face, t);
        if (tick.event) {
          setRecentLaugh(true);
          if (flashTimer) clearTimeout(flashTimer);
          flashTimer = setTimeout(() => setRecentLaugh(false), 1200);
          onLaughRef.current?.(tick.event);
        }
        // Surface the live label at a low rate, only when it changes.
        if (tick.expression !== lastExpr && t - lastExprAt >= EXPRESSION_THROTTLE_MS) {
          lastExpr = tick.expression;
          lastExprAt = t;
          setExpression(tick.expression);
        }
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
        // Face model loads in the background; audio-only until it is ready.
        if (hasVideo) {
          faceDetector.init().catch((error) => {
            console.warn('Face detector unavailable, using audio only', error);
          });
          if (DETECT_MOUTH_COVER) {
            handDetector.init().catch((error) => {
              console.warn('Hand detector unavailable, mouth-cover check off', error);
            });
          }
        }
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
      faceDetector.close();
      handDetector.close();
      const ctx = overlayCanvas?.getContext('2d');
      if (overlayCanvas && ctx) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      setRecentLaugh(false);
      setFaceAvailable(false);
      setExpression('no-face');
      setStatus('stopped');
    };
  }, [stream, enabled, videoRef, overlayRef]);

  return { status, recentLaugh, faceAvailable, expression };
}
