import { withDatabase } from '@/lib/db';
import { fetchCloudflareTurn } from '@/lib/turn-providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

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

async function getCloudflareEnvCredentials(): Promise<IceServerEntry[]> {
  const turnTokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!turnTokenId || !apiToken) return [];

  try {
    const credentials = await fetchCloudflareTurn({
      turnTokenId,
      apiToken,
      ttlSeconds: process.env.CLOUDFLARE_TURN_TTL_SECONDS ?? '86400',
    });
    return [{ urls: credentials.urls, username: credentials.username, credential: credentials.credential }];
  } catch {
    return [];
  }
}

export async function GET() {
  // The admin-managed pool is the only credentialed source now. Public STUN
  // is appended as a last resort so the list is never empty (no relay, but
  // keeps direct/host candidates working).
  const pool = await getPool();
  pool.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  const cloudflare = await getCloudflareEnvCredentials();
  const iceServers = [...pool.map((item) => item.entry), ...cloudflare, ...FALLBACK_ICE_SERVERS];

  return Response.json({ iceServers });
}
