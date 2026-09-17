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

// Cache the DB pool result to avoid hitting Postgres on every request.
// Admin changes to TURN servers are rare; 60s TTL is fine.
let cachedPool: PoolEntry[] | null = null;
let cachedPoolAt = 0;
const POOL_CACHE_TTL_MS = 60_000;

async function getPool(): Promise<PoolEntry[]> {
  const now = Date.now();
  if (cachedPool && now - cachedPoolAt < POOL_CACHE_TTL_MS) return cachedPool;

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

  cachedPool = [...fromServers, ...fromProviders];
  cachedPoolAt = now;
  return cachedPool;
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
  const [pool, cloudflare] = await Promise.all([getPool(), getCloudflareEnvCredentials()]);
  pool.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  const iceServers = [...pool.map((item) => item.entry), ...cloudflare, ...FALLBACK_ICE_SERVERS];

  return Response.json({ iceServers });
}
