import { withDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const removed = await withDatabase((database) => {
    const before = database.data.turnProviders.length;
    database.data.turnProviders = database.data.turnProviders.filter((provider) => provider.id !== id);
    return database.data.turnProviders.length < before;
  });

  if (!removed) return Response.json({ error: 'TURN provider not found' }, { status: 404 });
  return Response.json({ ok: true });
}
