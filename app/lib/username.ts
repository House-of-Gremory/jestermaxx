// Persist the chosen name in the browser until a real user/DB exists, so it
// prefills on the next visit. Client-only, no account, no server. Shared by
// the video call screen and the intro builder so a name entered in either
// place carries over to the other.
const USERNAME_STORAGE_KEY = 'jestermaxx:username';

export function loadSavedUsername(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(USERNAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveUsername(name: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USERNAME_STORAGE_KEY, name);
  } catch {
    // Storage can be unavailable (private mode / blocked) — non-fatal.
  }
}
