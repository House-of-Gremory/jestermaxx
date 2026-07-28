import type { IntroRecordResolved } from '../../lib/intro-templates';

// Caches the saved intro reel per username so /arena can skip the network
// round trip (and the intro gate) on repeat visits from the same browser.
function cacheKey(username: string) {
  return `jestermaxx:intro:${username}`;
}

export function loadCachedIntro(username: string): IntroRecordResolved | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(username));
    return raw ? (JSON.parse(raw) as IntroRecordResolved) : null;
  } catch {
    return null;
  }
}

export function saveCachedIntro(username: string, record: IntroRecordResolved) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cacheKey(username), JSON.stringify(record));
  } catch {
    // Storage can be unavailable (private mode / blocked) — non-fatal.
  }
}

export async function fetchIntro(username: string): Promise<IntroRecordResolved | null> {
  try {
    const response = await fetch(`/api/intro?username=${encodeURIComponent(username)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { intro: IntroRecordResolved | null };
    return data.intro;
  } catch {
    return null;
  }
}
