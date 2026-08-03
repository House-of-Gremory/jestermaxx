import { withDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

type IceServerEntry = { urls: string | string[]; username?: string; credential?: string };
type PoolEntry = { entry: IceServerEntry; latencyMs: number | null };

// The admin-managed pool (/admin) — both static servers and resolved
// providers, health-checked every 5 min by instrumentation.ts. Only entries
// currently confirmed "up" are returned, ranked together by latency so the
// single fastest working credential (regardless of source) goes first.
async function getPool(): Promise<PoolEntry[]> {
  const { servers, providers } = await withDatabase((database) => ({
    servers: database.data.turnServers,
    providers: database.data.turnProviders,
  }));

  const fromServers: PoolEntry[] = servers
    .filter((server) => server.status === 'up')
    .map((server) => ({
      entry: { urls: server.urls, username: server.username, credential: server.credential },
      latencyMs: server.latencyMs,
    }));

  const fromProviders: PoolEntry[] = providers
    .filter((provider) => provider.status === 'up' && provider.username && provider.credential)
    .map((provider) => ({
      entry: { urls: provider.urls, username: provider.username as string, credential: provider.credential as string },
      latencyMs: provider.latencyMs,
    }));

  return [...fromServers, ...fromProviders];
}

export async function GET() {
  // The admin-managed pool is the only credentialed source now. Public STUN
  // is appended as a last resort so the list is never empty (no relay, but
  // keeps direct/host candidates working).
  const pool = await getPool();
  pool.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  const iceServers = [...pool.map((item) => item.entry), ...FALLBACK_ICE_SERVERS];

  return Response.json({ iceServers });
}
