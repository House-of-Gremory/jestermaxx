import { withDatabase } from '@/lib/db';
import { createUserSessionToken, verifyPassword, USER_SESSION_COOKIE } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    identifier?: string; // username OR email
    password?: string;
  } | null;

  const identifier = body?.identifier?.trim() ?? '';
  const password = body?.password ?? '';
  if (!identifier || !password) {
    return Response.json({ error: 'Enter your username/email and password.' }, { status: 400 });
  }

  const user = await withDatabase((database) =>
    database.data.users.find(
      (candidate) =>
        candidate.username.toLowerCase() === identifier.toLowerCase() ||
        candidate.email === identifier.toLowerCase(),
    ),
  );

  // Same message for unknown user and wrong password, so the endpoint can't be
  // used to probe which usernames/emails exist.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ error: 'Invalid credentials.' }, { status: 401 });
  }

  const token = createUserSessionToken(user.id);
  return Response.json(
    { user: { username: user.username, email: user.email, verified: user.verified } },
    {
      headers: {
        'Set-Cookie': `${USER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
      },
    },
  );
}
