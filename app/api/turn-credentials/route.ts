import { withDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CREDENTIAL_EXPIRE_SECONDS = 21_600; // Xirsys max (6 hours)

type IceServerEntry = { urls: string | string[]; username?: string; credential?: string };

type XirsysResponse = {
  s: string;
  v?: { iceServers?: IceServerEntry };
};

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

async function getXirsysIceServers(): Promise<IceServerEntry[]> {
  const ident = process.env.XIRSYS_IDENT;
  const secret = process.env.XIRSYS_SECRET;
  const channel = process.env.XIRSYS_CHANNEL;
  if (!ident || !secret || !channel) return [];

  try {
    const auth = Buffer.from(`${ident}:${secret}`).toString('base64');
    const response = await fetch(
      `https://global.xirsys.net/_turn/${encodeURIComponent(channel)}?expire=${CREDENTIAL_EXPIRE_SECONDS}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ format: 'urls' }),
        cache: 'no-store',
      },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as XirsysResponse;
    return data.s === 'ok' && data.v?.iceServers ? [data.v.iceServers] : [];
  } catch {
    return [];
  }
}

// Xirsys issues short-lived TURN credentials per request, so this must not be
// cached and the ident/secret must stay server-side (never sent to the browser).
export async function GET() {
  // Ranked best-to-worst: the self-hosted admin pool first (health-checked,
  // fastest first), then Xirsys as a paid fallback, then public STUN (no
  // relay, but keeps the list non-empty) as the last resort.
  const [selfHosted, xirsys] = await Promise.all([getSelfHostedIceServers(), getXirsysIceServers()]);
  const iceServers = [...selfHosted, ...xirsys, ...FALLBACK_ICE_SERVERS];

  return Response.json({ iceServers });
}
