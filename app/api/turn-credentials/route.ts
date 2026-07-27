export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CREDENTIAL_EXPIRE_SECONDS = 21_600; // Xirsys max (6 hours)

type XirsysResponse = {
  s: string;
  v?: {
    iceServers?: {
      username?: string;
      credential?: string;
      urls?: string | string[];
    };
  };
};

// Xirsys issues short-lived TURN credentials per request, so this must not be
// cached and the ident/secret must stay server-side (never sent to the browser).
export async function GET() {
  const ident = process.env.XIRSYS_IDENT;
  const secret = process.env.XIRSYS_SECRET;
  const channel = process.env.XIRSYS_CHANNEL;

  if (!ident || !secret || !channel) {
    return Response.json({ iceServers: FALLBACK_ICE_SERVERS });
  }

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

    if (!response.ok) {
      return Response.json({ iceServers: FALLBACK_ICE_SERVERS });
    }

    const data = (await response.json()) as XirsysResponse;
    const iceServers = data.s === 'ok' && data.v?.iceServers ? [data.v.iceServers] : FALLBACK_ICE_SERVERS;

    return Response.json({ iceServers });
  } catch {
    return Response.json({ iceServers: FALLBACK_ICE_SERVERS });
  }
}
