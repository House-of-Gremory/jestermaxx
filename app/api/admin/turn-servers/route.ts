import { withDatabase, type TurnServerRecord } from '@/lib/db';
import { parseIceUrl } from '@/lib/turn-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Best-to-worst: working servers first (fastest latency first), then
// never-checked servers, then confirmed-down servers last.
function rankServers(servers: TurnServerRecord[]): TurnServerRecord[] {
  const rank = (server: TurnServerRecord) => (server.status === 'up' ? 0 : server.status === 'unknown' ? 1 : 2);
  return [...servers].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.status === 'up' && b.status === 'up') return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    return b.createdAt - a.createdAt;
  });
}

export async function GET() {
  const servers = await withDatabase((database) => database.data.turnServers);
  return Response.json({ servers: rankServers(servers) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { label?: string; urls?: string; username?: string; credential?: string }
    | null;

  const urls = (body?.urls ?? '')
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter(Boolean);
  const username = body?.username?.trim() ?? '';
  const credential = body?.credential?.trim() ?? '';
  const label = body?.label?.trim();

  if (urls.length === 0) {
    return Response.json({ error: 'At least one server URL is required' }, { status: 400 });
  }
  if (!username || !credential) {
    return Response.json({ error: 'Username and credential are required' }, { status: 400 });
  }

  const invalidUrl = urls.find((url) => !parseIceUrl(url));
  if (invalidUrl) {
    return Response.json({ error: `Could not parse URL: ${invalidUrl}` }, { status: 400 });
  }

  const record: TurnServerRecord = {
    id: `turn-${crypto.randomUUID()}`,
    label: label || parseIceUrl(urls[0])!.host,
    urls,
    username,
    credential,
    createdAt: Date.now(),
    status: 'unknown',
    latencyMs: null,
    lastCheckedAt: null,
    lastError: null,
  };

  await withDatabase((database) => {
    database.data.turnServers.push(record);
  });

  return Response.json({ server: record }, { status: 201 });
}
