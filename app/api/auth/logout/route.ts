import { NextResponse } from 'next/server';
import { USER_SESSION_COOKIE, userSessionCookieOptions } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  // Same flags as when it was set, or the browser won't match/clear the cookie.
  response.cookies.set(USER_SESSION_COOKIE, '', {
    ...userSessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
