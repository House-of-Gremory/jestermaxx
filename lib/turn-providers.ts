import type { TurnProviderType } from './turn-provider-types';

// Exchanges a TURN broker's account-level credentials for actual relay
// urls/username/credential. Unlike the static pool (lib/turn-protocol.ts),
// these brokers speak plain HTTPS, not the TURN wire protocol, and their
// returned credentials are often short-lived — callers are expected to
// re-resolve periodically (see refreshAllTurnProviders in turn-check.ts).

export type ResolvedTurnCredentials = {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: number | null;
};

async function fetchXirsys(config: Record<string, string>): Promise<ResolvedTurnCredentials> {
  const ident = config.ident?.trim();
  const secret = config.secret?.trim();
  const channel = config.channel?.trim();
  if (!ident || !secret || !channel) throw new Error('Xirsys requires ident, secret, and channel');

  const expireSeconds = 21_600; // Xirsys max (6 hours)
  const auth = Buffer.from(`${ident}:${secret}`).toString('base64');
  const response = await fetch(
    `https://global.xirsys.net/_turn/${encodeURIComponent(channel)}?expire=${expireSeconds}`,
    {
      method: 'PUT',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'urls' }),
      cache: 'no-store',
    },
  );
  if (!response.ok) throw new Error(`Xirsys request failed: HTTP ${response.status}`);

  const data = (await response.json()) as {
    s: string;
    v?: { iceServers?: { urls: string | string[]; username: string; credential: string } };
  };
  if (data.s !== 'ok' || !data.v?.iceServers) throw new Error(`Xirsys error: ${data.s}`);

  const { urls, username, credential } = data.v.iceServers;
  return {
    urls: Array.isArray(urls) ? urls : [urls],
    username,
    credential,
    expiresAt: Date.now() + expireSeconds * 1000,
  };
}

async function fetchMetered(config: Record<string, string>): Promise<ResolvedTurnCredentials> {
  const subdomain = config.subdomain?.trim();
  const apiKey = config.apiKey?.trim();
  if (!subdomain || !apiKey) throw new Error('Metered requires subdomain and apiKey');

  const response = await fetch(
    `https://${encodeURIComponent(subdomain)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Metered request failed: HTTP ${response.status}`);

  const entries = (await response.json()) as { urls: string; username?: string; credential?: string }[];
  const turnEntries = entries.filter(
    (entry): entry is { urls: string; username: string; credential: string } =>
      Boolean(entry.username && entry.credential),
  );
  if (turnEntries.length === 0) throw new Error('Metered returned no TURN (relay) entries, only STUN');

  return {
    urls: turnEntries.map((entry) => entry.urls),
    username: turnEntries[0].username,
    credential: turnEntries[0].credential,
    expiresAt: null, // Metered does not document a TTL for this endpoint's credentials
  };
}

const FETCHERS: Record<TurnProviderType, (config: Record<string, string>) => Promise<ResolvedTurnCredentials>> = {
  xirsys: fetchXirsys,
  metered: fetchMetered,
};

export async function resolveTurnProvider(
  type: TurnProviderType,
  config: Record<string, string>,
): Promise<ResolvedTurnCredentials> {
  return FETCHERS[type](config);
}
