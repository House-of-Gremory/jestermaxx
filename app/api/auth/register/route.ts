import { withDatabase, type UserRecord } from '@/lib/db';
import { createUserSessionToken, hashPassword, USER_SESSION_COOKIE } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    username?: string;
    email?: string;
    password?: string;
  } | null;

  const username = body?.username?.trim() ?? '';
  const email = body?.email?.trim().toLowerCase() ?? '';
  const password = body?.password ?? '';

  if (!USERNAME_RE.test(username)) {
    return Response.json(
      { error: 'Username must be 3-20 characters: letters, numbers, underscores.' },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (password.length < 8 || password.length > 72) {
    return Response.json({ error: 'Password must be 8-72 characters.' }, { status: 400 });
  }

  const result = await withDatabase((database) => {
    const usernameTaken = database.data.users.some(
      (user) => user.username.toLowerCase() === username.toLowerCase(),
    );
    if (usernameTaken) return { error: 'That username is taken.' };

    const emailTaken = database.data.users.some((user) => user.email === email);
    if (emailTaken) return { error: 'An account with that email already exists.' };

    const user: UserRecord = {
      id: `user-${crypto.randomUUID()}`,
      username,
      email,
      passwordHash: hashPassword(password),
      // Flipped manually from the admin panel for now (no email verification yet).
      verified: false,
      createdAt: Date.now(),
    };
    database.data.users.push(user);
    return { user };
  });

  if ('error' in result) return Response.json({ error: result.error }, { status: 409 });

  const token = createUserSessionToken(result.user.id);
  return Response.json(
    {
      user: {
        username: result.user.username,
        email: result.user.email,
        verified: result.user.verified,
      },
    },
    {
      headers: {
        'Set-Cookie': `${USER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
      },
    },
  );
}
