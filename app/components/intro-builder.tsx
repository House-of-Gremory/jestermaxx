'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import IntroPlayback from './intro-playback';
import { SLIDE_COUNT, TRANSITIONS, type IntroRecordResolved, type TransitionId } from '../../lib/intro-templates';
import { loadSavedUsername, saveUsername } from '../lib/username';
import { saveCachedIntro } from '../lib/intro-cache';

type BuilderSlide = { dataUrl: string; text: string; xPct: number; yPct: number };
type Stage = 'name' | 'capture' | 'style' | 'transition' | 'preview' | 'saving';

const EMPTY_SLOTS: (BuilderSlide | null)[] = [null, null, null, null];

export default function IntroBuilder() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') || '/arena';
  const queryUsername = searchParams.get('username')?.trim() ?? '';

  const [usernameInput, setUsernameInput] = useState('');
  const [username, setUsername] = useState(queryUsername);
  const [stage, setStage] = useState<Stage>(queryUsername ? 'capture' : 'name');
  // Withholds the name stage until the session check finishes (skipped when a
  // username was passed in, since then there is nothing to decide).
  const [checkingAccount, setCheckingAccount] = useState(!queryUsername);

  const [slots, setSlots] = useState<(BuilderSlide | null)[]>(EMPTY_SLOTS);
  const [styleIndex, setStyleIndex] = useState(0);
  const [transitionId, setTransitionId] = useState<TransitionId>(TRANSITIONS[0].id);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const styleImageRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // A signed-in player already has a name, so the name stage is skipped
  // entirely — letting them retype it here would defeat the point of the
  // account. Guests keep the old behaviour: the last name they used is
  // prefilled into the form. Skipped when the page was linked to with a
  // username already known (e.g. from the /arena gate).
  useEffect(() => {
    if (queryUsername) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/me', { cache: 'no-store' });
        const data = (await response.json()) as { user: { username: string } | null };
        if (cancelled) return;

        const accountName = data.user?.username;
        if (accountName) {
          saveUsername(accountName);
          setUsername(accountName);
          setStage('capture');
          return;
        }
        const saved = loadSavedUsername();
        if (saved) setUsernameInput(saved);
      } catch {
        const saved = loadSavedUsername();
        if (!cancelled && saved) setUsernameInput(saved);
      } finally {
        if (!cancelled) setCheckingAccount(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryUsername]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  // Acquire the webcam whenever the capture stage is active. A working
  // camera is required (no upload fallback) — this doubles as the
  // online/liveness check the landing page calls "Camera Check".
  useEffect(() => {
    if (stage !== 'capture') return;
    let cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is required to build your intro reel — allow it and try again.');
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        if (!cancelled) {
          setCameraError('Camera access is required to build your intro reel — allow it and try again.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [stage, cameraAttempt]);

  // Release the camera on unmount no matter which stage we left it in.
  useEffect(() => stopCamera, []);

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = usernameInput.trim().slice(0, 32);
    if (!name) return;
    saveUsername(name);
    setUsername(name);
    setStage('capture');
  }

  function capturePhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const targetIndex = slots.findIndex((slot) => slot === null);
    if (!video || !canvas || !video.videoWidth || targetIndex === -1) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    const next = [...slots];
    next[targetIndex] = { dataUrl, text: '', xPct: 50, yPct: 85 };
    setSlots(next);

    if (next.every((slot) => slot !== null)) {
      stopCamera();
      setStyleIndex(0);
      setStage('style');
    }
  }

  function retakeLast() {
    setSlots((prev) => {
      const lastFilledIndex = prev.reduce((found, slot, i) => (slot ? i : found), -1);
      if (lastFilledIndex === -1) return prev;
      const next = [...prev];
      next[lastFilledIndex] = null;
      return next;
    });
  }

  function updateSlideAt(index: number, patch: Partial<BuilderSlide>) {
    setSlots((prev) => {
      const current = prev[index];
      if (!current) return prev;
      const next = [...prev];
      next[index] = { ...current, ...patch };
      return next;
    });
  }

  function handleCaptionPointerDown(event: React.PointerEvent<HTMLSpanElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
  }

  function handleCaptionPointerMove(event: React.PointerEvent<HTMLSpanElement>) {
    if (!draggingRef.current) return;
    const container = styleImageRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const xPct = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    updateSlideAt(styleIndex, { xPct, yPct });
  }

  function handleCaptionPointerUp() {
    draggingRef.current = false;
  }

  function retryCamera() {
    setCameraError(null);
    setCameraAttempt((n) => n + 1);
  }

  function startOver() {
    stopCamera();
    setSlots(EMPTY_SLOTS);
    setStyleIndex(0);
    setTransitionId(TRANSITIONS[0].id);
    setCameraError(null);
    setSaveError(null);
    setStage('capture');
  }

  async function handleSave() {
    setStage('saving');
    setSaveError(null);
    try {
      const response = await fetch('/api/intro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          transitionId,
          slides: filledSlots.map((slot) => ({
            dataUrl: slot.dataUrl,
            text: slot.text,
            xPct: slot.xPct,
            yPct: slot.yPct,
          })),
        }),
      });
      if (!response.ok) throw new Error(`Server said ${response.status}`);

      const data = (await response.json()) as { intro: IntroRecordResolved };
      saveCachedIntro(username, data.intro);
      router.push(nextPath);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save intro');
      setStage('preview');
    }
  }

  const filledSlots = slots.filter((slot): slot is BuilderSlide => slot !== null);
  const capturedCount = filledSlots.length;
  const previewSlides = filledSlots.map((slot) => ({
    url: slot.dataUrl,
    text: slot.text,
    xPct: slot.xPct,
    yPct: slot.yPct,
  }));

  return (
    <main className="relative min-h-screen bg-[#07060a] text-white font-mono">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5 py-6">
        <header className="mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="text-sm font-bold uppercase tracking-widest text-white/60 transition hover:text-lime-400"
          >
            ‹ Menu
          </Link>
          <h1 className="text-lg font-black uppercase tracking-[0.3em]">
            BUILD <span className="text-lime-400">INTRO</span>
          </h1>
          <span className="w-16" />
        </header>

        {stage === 'name' && !checkingAccount && (
          <section className="flex flex-1 flex-col items-center justify-center">
            <form
              onSubmit={submitName}
              className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-8"
            >
              <label htmlFor="username" className="text-xs font-bold uppercase tracking-widest text-white/60">
                Your name
              </label>
              <input
                id="username"
                value={usernameInput}
                onChange={(event) => setUsernameInput(event.target.value)}
                maxLength={32}
                required
                autoComplete="nickname"
                placeholder="e.g. jester42"
                className="rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-lime-400"
              />
              <button
                type="submit"
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300"
              >
                Start Intro
              </button>
            </form>
          </section>
        )}

        {stage === 'capture' && (
          <section className="flex flex-1 flex-col">
            <p className="mb-4 text-center text-sm text-white/70">
              Photo {Math.min(capturedCount + 1, SLIDE_COUNT)} of {SLIDE_COUNT} — this also checks your camera.
            </p>

            <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
              {cameraError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
                  <p className="text-sm text-red-400">{cameraError}</p>
                  <button
                    onClick={retryCamera}
                    className="rounded-xl border border-white/20 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white/80 hover:border-lime-400 hover:text-lime-400"
                  >
                    Retry camera
                  </button>
                </div>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />

            <div className="mt-4 flex justify-center gap-3">
              {slots.map((slot, i) => (
                <div
                  key={i}
                  className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/5 text-white/30"
                >
                  {slot ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={slot.dataUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs font-bold">{i + 1}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={capturePhoto}
                disabled={!!cameraError || capturedCount >= SLIDE_COUNT}
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300 disabled:opacity-40"
              >
                📸 Capture
              </button>
              {capturedCount > 0 && (
                <button
                  onClick={retakeLast}
                  className="rounded-xl border border-white/20 bg-white/5 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white/80 transition hover:border-fuchsia-400/60 hover:text-fuchsia-300"
                >
                  Retake last
                </button>
              )}
            </div>
          </section>
        )}

        {stage === 'style' && filledSlots[styleIndex] && (
          <section className="flex flex-1 flex-col">
            <p className="mb-4 text-center text-sm text-white/70">
              Caption {styleIndex + 1} of {SLIDE_COUNT} — drag the text anywhere on the photo.
            </p>

            <div
              ref={styleImageRef}
              className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={filledSlots[styleIndex].dataUrl} alt="" className="h-full w-full object-cover" />
              {filledSlots[styleIndex].text && (
                <span
                  onPointerDown={handleCaptionPointerDown}
                  onPointerMove={handleCaptionPointerMove}
                  onPointerUp={handleCaptionPointerUp}
                  className="intro-caption absolute -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none active:cursor-grabbing"
                  style={{ left: `${filledSlots[styleIndex].xPct}%`, top: `${filledSlots[styleIndex].yPct}%` }}
                >
                  {filledSlots[styleIndex].text}
                </span>
              )}
            </div>

            <input
              value={filledSlots[styleIndex].text}
              onChange={(event) => updateSlideAt(styleIndex, { text: event.target.value.slice(0, 80) })}
              maxLength={80}
              placeholder="Optional caption (drag it once you type something)"
              className="mt-4 rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-lime-400"
            />

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {styleIndex > 0 && (
                <button
                  onClick={() => setStyleIndex((i) => i - 1)}
                  className="rounded-xl border border-white/20 bg-white/5 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white/80 transition hover:border-white/40"
                >
                  Back
                </button>
              )}
              <button
                onClick={() =>
                  styleIndex < SLIDE_COUNT - 1 ? setStyleIndex((i) => i + 1) : setStage('transition')
                }
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300"
              >
                {styleIndex < SLIDE_COUNT - 1 ? 'Next photo ›' : 'Choose transition ›'}
              </button>
              <button
                onClick={startOver}
                className="text-xs font-bold uppercase tracking-widest text-white/40 hover:text-red-400"
              >
                Start over
              </button>
            </div>
          </section>
        )}

        {stage === 'transition' && (
          <section className="flex flex-1 flex-col">
            <p className="mb-4 text-center text-sm text-white/70">Pick a transition for your reel.</p>

            <div className="mx-auto aspect-video w-full max-w-md overflow-hidden rounded-2xl border border-white/10">
              <IntroPlayback slides={previewSlides} transitionId={transitionId} />
            </div>

            <div className="mt-6 flex justify-center gap-3">
              {TRANSITIONS.map((transition) => (
                <button
                  key={transition.id}
                  onClick={() => setTransitionId(transition.id)}
                  className={`rounded-xl border px-5 py-3 text-sm font-bold uppercase tracking-widest transition ${
                    transitionId === transition.id
                      ? 'border-lime-400 bg-lime-400/10 text-lime-400'
                      : 'border-white/20 bg-white/5 text-white/70 hover:border-white/40'
                  }`}
                >
                  {transition.label}
                </button>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => setStage('preview')}
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300"
              >
                Preview ›
              </button>
              <button
                onClick={startOver}
                className="text-xs font-bold uppercase tracking-widest text-white/40 hover:text-red-400"
              >
                Start over
              </button>
            </div>
          </section>
        )}

        {(stage === 'preview' || stage === 'saving') && (
          <section className="flex flex-1 flex-col">
            <p className="mb-4 text-center text-sm text-white/70">
              This plays while your opponent connects — instead of a loading screen.
            </p>

            <div className="mx-auto aspect-video w-full max-w-md overflow-hidden rounded-2xl border border-white/10">
              <IntroPlayback slides={previewSlides} transitionId={transitionId} />
            </div>

            {saveError && <p className="mt-4 text-center text-sm text-red-400">{saveError}</p>}

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={handleSave}
                disabled={stage === 'saving'}
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300 disabled:opacity-60"
              >
                {stage === 'saving' ? 'Saving…' : 'Save intro'}
              </button>
              <button
                onClick={startOver}
                disabled={stage === 'saving'}
                className="rounded-xl border border-white/20 bg-white/5 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white/80 transition hover:border-red-500/60 hover:text-red-400 disabled:opacity-60"
              >
                Start over
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
