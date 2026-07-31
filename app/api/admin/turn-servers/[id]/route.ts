import { withDatabase } from '@/lib/db';
import { parseIceUrl } from '@/lib/turn-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const removed = await withDatabase((database) => {
    const before = database.data.turnServers.length;
    database.data.turnServers = database.data.turnServers.filter((server) => server.id !== id);
    return database.data.turnServers.length < before;
  });

  if (!removed) return Response.json({ error: 'TURN server not found' }, { status: 404 });
  return Response.json({ ok: true });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as
    | { label?: string; urls?: string; username?: string; credential?: string }
    | null;

  const result = await withDatabase((database) => {
    const record = database.data.turnServers.find((server) => server.id === id);
    if (!record) return { error: 'TURN server not found' as const, status: 404 as const };

    if (body?.urls !== undefined) {
      const urls = body.urls
        .split(/[\n,]/)
        .map((url) => url.trim())
        .filter(Boolean);
      if (urls.length === 0) return { error: 'At least one server URL is required' as const, status: 400 as const };
      const invalidUrl = urls.find((url) => !parseIceUrl(url));
      if (invalidUrl) return { error: `Could not parse URL: ${invalidUrl}` as const, status: 400 as const };
      record.urls = urls;
    }
    if (body?.username !== undefined) {
      if (!body.username.trim()) return { error: 'Username is required' as const, status: 400 as const };
      record.username = body.username.trim();
    }
    if (body?.credential !== undefined) {
      if (!body.credential.trim()) return { error: 'Credential is required' as const, status: 400 as const };
      record.credential = body.credential.trim();
    }
    if (body?.label !== undefined) record.label = body.label.trim();

    // Any config change invalidates the last health check result.
    record.status = 'unknown';
    record.latencyMs = null;
    record.lastCheckedAt = null;
    record.lastError = null;

    return { server: record };
  });

  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
