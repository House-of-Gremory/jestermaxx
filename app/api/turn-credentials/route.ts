import { withDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

type IceServerEntry = { urls: string | string[]; username?: string; credential?: string };

// The admin-managed pool (/admin), health-checked every 5 min by
// instrumentation.ts. Only servers currently confirmed "up" are returned,
// fastest first.
async function getSelfHostedIceServers(): Promise<IceServerEntry[]> {
  const servers = await withDatabase((database) => database.data.turnServers);
  return servers
    .filter((server) => server.status === 'up')
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .map((server) => ({ urls: server.urls, username: server.username, credential: server.credential }));
}

export async function GET() {
  // The admin-managed pool is the only credentialed source now. Public STUN
  // is appended as a last resort so the list is never empty (no relay, but
  // keeps direct/host candidates working).
  const selfHosted = await getSelfHostedIceServers();
  const iceServers = [...selfHosted, ...FALLBACK_ICE_SERVERS];

  return Response.json({ iceServers });
}
