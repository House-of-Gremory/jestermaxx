import { withDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Admin-only (the proxy guards /api/admin/*): list users for manual review.
// Password hashes stay server-side.
export async function GET() {
  const users = await withDatabase((database) =>
    database.data.users
      .map(({ id, username, email, verified, createdAt }) => ({
        id,
        username,
        email,
        verified,
        createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  );
  return Response.json({ users });
}

// Manual verification toggle — the stand-in until email verification exists.
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    id?: string;
    verified?: boolean;
  } | null;

  const id = body?.id;
  const verified = body?.verified;
  if (!id || typeof verified !== 'boolean') {
    return Response.json({ error: 'id and verified are required' }, { status: 400 });
  }

  const updated = await withDatabase((database) => {
    const user = database.data.users.find((candidate) => candidate.id === id);
    if (!user) return null;
    user.verified = verified;
    return { id: user.id, username: user.username, verified: user.verified };
  });

  if (!updated) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({ user: updated });
}

// Permanently removes an account. The user's intro reel goes with it, since it
// is keyed by username and would otherwise be orphaned (and silently reused if
// someone later registered the same name).
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id;
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

  const removed = await withDatabase((database) => {
    const user = database.data.users.find((candidate) => candidate.id === id);
    if (!user) return null;

    database.data.users = database.data.users.filter((candidate) => candidate.id !== id);
    database.data.intros = database.data.intros.filter(
      (intro) => intro.username.toLowerCase() !== user.username.toLowerCase(),
    );
    return { id: user.id, username: user.username };
  });

  if (!removed) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({ user: removed });
}
