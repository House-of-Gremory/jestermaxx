import { withDatabase } from './db';
import { checkIceUrl } from './turn-protocol';
import { resolveTurnProvider } from './turn-providers';

const CHECK_TIMEOUT_MS = 4000;
const PROVIDER_REFRESH_MARGIN_MS = 30 * 60 * 1000; // re-resolve 30 min before expiry

// Runs a real TURN Allocate handshake (via turn-protocol.ts) against every
// stored TURN server and updates its status/latency in place. A server is
// "up" if at least one of its urls produced a working allocation; latencyMs
// is the fastest working url, used to rank servers best-to-worst.
export async function checkAllTurnServers(): Promise<void> {
  const servers = await withDatabase((database) => database.data.turnServers.map((server) => ({ ...server })));
  if (servers.length === 0) return;

  const results = await Promise.all(
    servers.map(async (server) => {
      let bestLatencyMs: number | null = null;
      let lastError: string | null = null;

      for (const url of server.urls) {
        const result = await checkIceUrl(url, server.username, server.credential, CHECK_TIMEOUT_MS);
        if (result.ok) {
          if (bestLatencyMs === null || result.latencyMs < bestLatencyMs) bestLatencyMs = result.latencyMs;
        } else {
          lastError = result.error;
        }
      }

      return { id: server.id, bestLatencyMs, lastError };
    }),
  );

  await withDatabase((database) => {
    const now = Date.now();
    for (const result of results) {
      const record = database.data.turnServers.find((server) => server.id === result.id);
      if (!record) continue;

      record.lastCheckedAt = now;
      if (result.bestLatencyMs !== null) {
        record.status = 'up';
        record.latencyMs = result.bestLatencyMs;
        record.lastError = null;
      } else {
        record.status = 'down';
        record.latencyMs = null;
        record.lastError = result.lastError;
      }
    }
  });
}

// Re-resolves each TURN provider's broker credentials (skipping ones whose
// last resolve is still comfortably before expiry, unless `force`), then
// runs the same real TURN Allocate handshake against whatever it got back.
// `force` re-resolves everything regardless of expiry — used by the "Check
// now" button so it reflects fresh account state immediately.
export async function refreshAllTurnProviders(force = false): Promise<void> {
  const providers = await withDatabase((database) => database.data.turnProviders.map((provider) => ({ ...provider })));
  if (providers.length === 0) return;

  const now = Date.now();
  const results = await Promise.all(
    providers.map(async (provider) => {
      const needsResolve =
        force || !provider.username || !provider.credential || !provider.expiresAt
          ? true
          : provider.expiresAt - now < PROVIDER_REFRESH_MARGIN_MS;

      let urls = provider.urls;
      let username = provider.username;
      let credential = provider.credential;
      let expiresAt = provider.expiresAt;
      let resolveError: string | null = null;

      if (needsResolve) {
        try {
          const resolved = await resolveTurnProvider(provider.type, provider.config);
          urls = resolved.urls;
          username = resolved.username;
          credential = resolved.credential;
          expiresAt = resolved.expiresAt;
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }
      }

      if (resolveError || !username || !credential || urls.length === 0) {
        return {
          id: provider.id,
          urls,
          username,
          credential,
          expiresAt,
          bestLatencyMs: null as number | null,
          lastError: resolveError ?? 'No credentials resolved yet',
        };
      }

      let bestLatencyMs: number | null = null;
      let lastError: string | null = null;
      for (const url of urls) {
        const result = await checkIceUrl(url, username, credential, CHECK_TIMEOUT_MS);
        if (result.ok) {
          if (bestLatencyMs === null || result.latencyMs < bestLatencyMs) bestLatencyMs = result.latencyMs;
        } else {
          lastError = result.error;
        }
      }

      return { id: provider.id, urls, username, credential, expiresAt, bestLatencyMs, lastError };
    }),
  );

  await withDatabase((database) => {
    const checkedAt = Date.now();
    for (const result of results) {
      const record = database.data.turnProviders.find((provider) => provider.id === result.id);
      if (!record) continue;

      record.urls = result.urls;
      record.username = result.username;
      record.credential = result.credential;
      record.expiresAt = result.expiresAt;
      record.lastCheckedAt = checkedAt;
      if (result.bestLatencyMs !== null) {
        record.status = 'up';
        record.latencyMs = result.bestLatencyMs;
        record.lastError = null;
      } else {
        record.status = 'down';
        record.latencyMs = null;
        record.lastError = result.lastError;
      }
    }
  });
}
