'use client';

import { useEffect, useRef, useState } from 'react';
import { SLIDE_HOLD_MS, type TransitionId } from '../../lib/intro-templates';

export type IntroPlaybackSlide = {
  url: string;
  text: string;
  xPct: number;
  yPct: number;
  pendingDataUrl?: string;
};

const ANIM_CLASS: Record<TransitionId, string> = {
  fade: 'intro-anim-fade',
  slide: 'intro-anim-slide',
  zoom: 'intro-anim-zoom',
};

// Loops the 4-photo intro reel: one slide at a time, replaying the fixed
// templated transition on every change and rendering the caption (fixed
// font, free position) on top. Reused by the builder's live preview and by
// the call screen's waiting state.
export default function IntroPlayback({
  slides,
  transitionId,
  className = '',
  onCycleComplete,
}: {
  slides: IntroPlaybackSlide[];
  transitionId: TransitionId;
  className?: string;
  // Fires once every time the reel finishes its last slide and loops back to
  // the first — lets a caller wait for "played all the way through" instead
  // of cutting the reel off mid-loop.
  onCycleComplete?: () => void;
}) {
  const [index, setIndex] = useState(0);

  // Keep the latest callback in a ref rather than the effect's deps below,
  // so a parent passing a fresh arrow function every render doesn't reset
  // the slide timer each time.
  const onCycleCompleteRef = useRef(onCycleComplete);
  useEffect(() => {
    onCycleCompleteRef.current = onCycleComplete;
  }, [onCycleComplete]);

  // Reset to the first slide whenever a different reel/transition is handed
  // in. Adjusted during render (React's documented pattern for this) rather
  // than in an effect, so it takes effect in the same commit, not the next.
  const slidesKey = `${transitionId}|${slides.map((slide) => slide.url).join(',')}`;
  const [lastSlidesKey, setLastSlidesKey] = useState(slidesKey);
  if (slidesKey !== lastSlidesKey) {
    setLastSlidesKey(slidesKey);
    setIndex(0);
  }

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setTimeout(() => {
      const next = (index + 1) % slides.length;
      setIndex(next);
      if (next === 0) onCycleCompleteRef.current?.();
    }, SLIDE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [index, slides.length]);

  const slide = slides[index];
  if (!slide) return null;

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      {/* Keying by index+transition forces a remount so the CSS entrance
          animation replays every slide instead of only running once. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={`${index}-${transitionId}`}
        src={slide.url || slide.pendingDataUrl || ''}
        alt=""
        className={`h-full w-full object-cover ${ANIM_CLASS[transitionId]}`}
      />
      {slide.text && (
        <span
          className="intro-caption absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${slide.xPct}%`, top: `${slide.yPct}%` }}
        >
          {slide.text}
        </span>
      )}
    </div>
  );
}
