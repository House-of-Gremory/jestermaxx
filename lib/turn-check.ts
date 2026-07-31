import { withDatabase } from './db';
import { checkIceUrl } from './turn-protocol';

const CHECK_TIMEOUT_MS = 4000;

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
