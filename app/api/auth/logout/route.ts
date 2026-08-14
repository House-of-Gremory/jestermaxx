import { USER_SESSION_COOKIE } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  return Response.json(
    { ok: true },
    {
      headers: {
        'Set-Cookie': `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    },
  );
}
