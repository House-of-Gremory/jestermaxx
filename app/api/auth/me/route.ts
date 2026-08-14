import { cookies } from 'next/headers';
import { withDatabase } from '@/lib/db';
import { USER_SESSION_COOKIE, verifyUserSessionToken } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Who is logged in, if anyone. `user: null` (not a 401) for guests, so the
// landing page can render either state from one cheap call.
export async function GET() {
  const cookieStore = await cookies();
  const userId = verifyUserSessionToken(cookieStore.get(USER_SESSION_COOKIE)?.value);
  if (!userId) return Response.json({ user: null });

  const user = await withDatabase((database) =>
    database.data.users.find((candidate) => candidate.id === userId),
  );
  if (!user) return Response.json({ user: null });

  return Response.json({
    user: { username: user.username, email: user.email, verified: user.verified },
  });
}
