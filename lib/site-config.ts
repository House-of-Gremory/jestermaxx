export const SITE_NAME = 'Jester Maxing';
export const SITE_TAGLINE = 'A live 1v1 try-not-to-laugh game with strangers.';
export const SITE_DESCRIPTION =
  'Match with a stranger, jump into a quick video duel, and try to make each other laugh. Laugh detection, voice effects, and weird attacks decide who wins.';

export function getSiteUrl(): URL {
  const rawUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  try {
    return new URL(rawUrl);
  } catch {
    return new URL('http://localhost:3000');
  }
}
