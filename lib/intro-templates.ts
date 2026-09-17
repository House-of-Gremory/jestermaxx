// Fixed, non-customizable intro reel templates. Users only ever choose which
// one of these to use, plus caption text/position — never new fonts/effects.

export const TRANSITIONS = [
  { id: 'fade', label: 'Fade' },
  { id: 'slide', label: 'Slide' },
  { id: 'zoom', label: 'Zoom Punch' },
] as const;

export type TransitionId = (typeof TRANSITIONS)[number]['id'];

export const TRANSITION_IDS = TRANSITIONS.map((t) => t.id) as TransitionId[];

export function isTransitionId(value: unknown): value is TransitionId {
  return typeof value === 'string' && (TRANSITION_IDS as string[]).includes(value);
}

export const SLIDE_COUNT = 4;

// How long each slide holds on screen before the next one transitions in.
export const SLIDE_HOLD_MS = 1800;

// Client-safe shapes (no fs/redis deps) shared by the API route and every
// component that renders or caches a saved intro reel.
export type IntroSlideResolved = {
  url: string;
  text: string;
  xPct: number;
  yPct: number;
  // Base64 image data, present until the slide is uploaded to R2.
  pendingDataUrl?: string;
};
export type IntroRecordResolved = {
  username: string;
  slides: IntroSlideResolved[];
  transitionId: TransitionId;
  createdAt: number;
};
