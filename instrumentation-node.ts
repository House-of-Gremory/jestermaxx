import { tryAcquireLock } from '@/lib/db';
import { checkAllTurnServers } from '@/lib/turn-check';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_TTL_SECONDS = 280; // just under 5 min, so a slow instance can't hold it into the next bucket

async function runCheckCycle() {
  try {
    // Wall-clock bucket (not a shared counter) so independent server
    // instances — each running their own unsynchronized setInterval — still
    // only have one of them actually run the check for a given ~5 min window.
    const bucket = Math.floor(Date.now() / CHECK_INTERVAL_MS);
    const acquired = await tryAcquireLock(`jestermaxing:turn-check:lock:${bucket}`, LOCK_TTL_SECONDS);
    if (!acquired) return;

    await checkAllTurnServers();
  } catch (error) {
    console.error('TURN server health check failed:', error);
  }
}

setTimeout(() => void runCheckCycle(), 15_000);
setInterval(() => void runCheckCycle(), CHECK_INTERVAL_MS);
