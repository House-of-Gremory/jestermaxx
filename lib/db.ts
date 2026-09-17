import { Redis } from '@upstash/redis';
import { Pool, type PoolClient } from 'pg';
import type { TurnProviderType } from './turn-provider-types';

export type SignalType = 'peer-joined' | 'offer' | 'answer' | 'candidate' | 'bye';

export type SignalMessage = {
  type: SignalType;
  payload?: unknown;
};

export type ParticipantRecord = {
  id: string;
  roomId: string;
  username: string;
  lastSeen: number;
};

export type RoomRecord = {
  id: string;
  participantIds: string[];
  createdAt: number;
};

export type IntroSlide = {
  imagePath: string;
  text: string;
  xPct: number;
  yPct: number;
  // Pending base64 image data, stored until another player joins and
  // triggers the R2 upload. Once uploaded, imagePath is set and this is cleared.
  pendingDataUrl?: string;
};

export type IntroRecord = {
  username: string;
  slides: IntroSlide[];
  transitionId: string;
  createdAt: number;
};

export type TurnServerStatus = 'unknown' | 'up' | 'down';

export type TurnServerRecord = {
  id: string;
  label: string;
  // One or more RTCIceServer-style URLs sharing the same credential, e.g.
  // ["turn:relay.example.com:3478?transport=udp", "turns:relay.example.com:5349"].
  urls: string[];
  username: string;
  credential: string;
  createdAt: number;
  status: TurnServerStatus;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
};

// A broker (Xirsys, Metered, …) whose account-level credentials get
// exchanged for actual relay urls/username/credential on a schedule, rather
// than a fixed static credential like TurnServerRecord.
export type TurnProviderRecord = {
  id: string;
  label: string;
  type: TurnProviderType;
  config: Record<string, string>;
  // Last successfully resolved relay credentials (null until first resolve).
  urls: string[];
  username: string | null;
  credential: string | null;
  expiresAt: number | null;
  createdAt: number;
  status: TurnServerStatus;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
};

export type UserRecord = {
  id: string;
  username: string;
  email: string;
  // scrypt hash as "saltHex:hashHex" — never the raw password.
  passwordHash: string;
  // Manually flipped from the admin panel for now; automated verification later.
  verified: boolean;
  createdAt: number;
};

// Admin/config data only (intros, TURN servers/providers, users) — low-frequency,
// shared under one key/lock. Room matchmaking and signaling messages live in
// their own stores below so the 400ms polling hot path never contends with
// this or with other rooms (see withRoomIndex/withRoom).
export type Database = {
  intros: IntroRecord[];
  turnServers: TurnServerRecord[];
  turnProviders: TurnProviderRecord[];
  users: UserRecord[];
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;
const postgresUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const globalPg = globalThis as unknown as {
  __jesterPgPool?: Pool;
  __jesterPgReady?: Promise<void>;
  __jesterPgDisabled?: boolean;
};
const pgPool =
  postgresUrl
    ? (globalPg.__jesterPgPool ??= new Pool({
        connectionString: postgresUrl,
        ssl: { rejectUnauthorized: false },
        // Direct Supabase connection (bypasses PgBouncer pooler).
        // No shared pooler limit — each invocation gets its own pool.
        max: 4,
        connectionTimeoutMillis: 3_000,
        idleTimeoutMillis: 10_000,
      }))
    : null;
const REDIS_DATA_KEY = 'jestermaxing:signaling';
const REDIS_LOCK_KEY = 'jestermaxing:signaling:lock';

// Matchmaking index: which rooms exist and how many participants each has.
// Touched only on join/leave, never on the polling hot path.
const REDIS_ROOM_INDEX_KEY = 'jestermaxing:signaling:rooms';
const REDIS_ROOM_INDEX_LOCK_KEY = 'jestermaxing:signaling:rooms:lock';

function roomParticipantsKey(roomId: string) {
  return `jestermaxing:signaling:room:${roomId}:participants`;
}
function roomMessagesKey(roomId: string, participantId: string) {
  return `jestermaxing:signaling:room:${roomId}:messages:${participantId}`;
}

// TTL refreshed on every write so an abandoned room's keys eventually expire
// on their own — there's no single "delete the room" operation any more
// (see the lock-free room store below), so this is what actually reclaims
// dead rooms.
const ROOM_KEY_TTL_SECONDS = 60 * 60;

// Client polls every ~400ms (refreshing lastSeen), so 12s without a
// single successful poll means the tab is really gone.
const PARTICIPANT_TTL_MS = 12_000;

// Local development fallback. Vercel instances do not share process memory,
// so production requires the shared Redis store configured above.
type LocalRoom = {
  participants: Map<string, ParticipantRecord>;
  messages: Map<string, SignalMessage[]>;
};
const globalStore = globalThis as unknown as {
  __jesterDb?: Database;
  __jesterRooms?: RoomRecord[];
  __jesterRoomData?: Map<string, LocalRoom>;
};
const localStore: Database = (globalStore.__jesterDb ??= {
  intros: [],
  turnServers: [],
  turnProviders: [],
  users: [],
});
const localRooms: RoomRecord[] = (globalStore.__jesterRooms ??= []);
const localRoomData: Map<string, LocalRoom> = (globalStore.__jesterRoomData ??= new Map());

function getLocalRoom(roomId: string): LocalRoom {
  let room = localRoomData.get(roomId);
  if (!room) {
    room = { participants: new Map(), messages: new Map() };
    localRoomData.set(roomId, room);
  }
  return room;
}

function emptyDatabase(): Database {
  return {
    intros: [],
    turnServers: [],
    turnProviders: [],
    users: [],
  };
}

function normalizeDatabase(data: Partial<Database> | null | undefined): Database {
  return {
    ...emptyDatabase(),
    ...data,
    intros: data?.intros ?? [],
    turnServers: data?.turnServers ?? [],
    turnProviders: data?.turnProviders ?? [],
    users: data?.users ?? [],
  };
}

async function ensurePostgresSchema() {
  if (!pgPool || globalPg.__jesterPgDisabled) return;
  globalPg.__jesterPgReady ??= (async () => {
    await pgPool.query(`
      create table if not exists jester_app_state (
        key text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists jester_rooms (
        id text primary key,
        participant_ids jsonb not null default '[]'::jsonb,
        created_at bigint not null
      );

      create table if not exists jester_participants (
        id text primary key,
        room_id text not null,
        username text not null,
        last_seen bigint not null
      );
      create index if not exists jester_participants_room_id_idx on jester_participants(room_id);

      create table if not exists jester_messages (
        id bigserial primary key,
        room_id text not null,
        participant_id text not null,
        message jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists jester_messages_target_idx
        on jester_messages(room_id, participant_id, id);

      create table if not exists jester_locks (
        key text primary key,
        expires_at bigint not null
      );
    `);
    await pgPool.query(
      `insert into jester_app_state (key, data)
       values ('main', $1::jsonb)
       on conflict (key) do nothing`,
      [JSON.stringify(emptyDatabase())],
    );
    await pgPool.query(
      `insert into jester_app_state (key, data)
       values ('room_index_lock', '{}'::jsonb)
       on conflict (key) do nothing`,
    );
  })();
  await globalPg.__jesterPgReady;
}

function disablePostgresInDevelopment(error: unknown) {
  if (process.env.NODE_ENV === 'production') return false;
  // In development, fall back to local store on ANY Postgres connection error
  // (wrong password, unreachable host, schema issues, etc.) so the dev server
  // never 500s — the app just uses in-memory storage until the next restart.
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  const isConnectionError =
    ['ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'EMAXCONNSESSION', 'EPIPE', 'ECONNRESET'].includes(code) ||
    message.includes('password authentication failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('could not connect') ||
    message.includes('max clients reached') ||
    message.includes('Connection terminated') ||
    message.includes('connection timeout');

  if (!isConnectionError) return false;

  console.warn(
    `Supabase Postgres is unreachable (${code || message.slice(0, 80)}); using the local development store until the dev server restarts.`,
  );
  globalPg.__jesterPgDisabled = true;
  globalPg.__jesterPgReady = undefined;
  void pgPool?.end().catch(() => {});
  return true;
}

const PG_RETRY_ATTEMPTS = 3;
const PG_RETRY_BASE_MS = 100;

function isTransientPgError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  return ['ETIMEOUT', 'ECONNRESET', 'EPIPE', '57P01', '57P02', '57P03', '08006', '08001', '08003'].includes(code);
}

async function withPostgresClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pgPool) throw new Error('Postgres is not configured');
  let lastError: unknown;
  for (let attempt = 0; attempt < PG_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await ensurePostgresSchema();
      if (globalPg.__jesterPgDisabled) throw new Error('Postgres is disabled');
      const client = await pgPool.connect();
      try {
        return await operation(client);
      } finally {
        client.release();
      }
    } catch (error) {
      lastError = error;
      if (disablePostgresInDevelopment(error)) throw new Error('Postgres is disabled');
      if (attempt < PG_RETRY_ATTEMPTS - 1 && isTransientPgError(error)) {
        await new Promise((r) => setTimeout(r, PG_RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function rowToParticipant(row: {
  id: string;
  room_id: string;
  username: string;
  last_seen: string | number;
}): ParticipantRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    username: row.username,
    lastSeen: Number(row.last_seen),
  };
}

function rowToRoom(row: {
  id: string;
  participant_ids: string[] | string;
  created_at: string | number;
}): RoomRecord {
  return {
    id: row.id,
    participantIds: Array.isArray(row.participant_ids)
      ? row.participant_ids
      : JSON.parse(row.participant_ids),
    createdAt: Number(row.created_at),
  };
}

// A single-attempt, non-retrying lock (unlike the read-modify-write lock
// below, which retries). Used to let multiple server instances race to claim
// a piece of periodic work — e.g. one wall-clock time bucket — without
// duplicating it. Returns true if this call won the lock.
export async function tryAcquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
      const now = Date.now();
      await client.query('delete from jester_locks where expires_at <= $1', [now]);
      const result = await client.query(
        `insert into jester_locks (key, expires_at)
         values ($1, $2)
         on conflict (key) do nothing`,
        [key, now + ttlSeconds * 1000],
      );
      return result.rowCount === 1;
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }
  if (!redis) return true;
  const acquired = await redis.set(key, '1', { nx: true, ex: ttlSeconds });
  return acquired === 'OK';
}

async function acquireLock(lockKey: string) {
  if (!redis) return null;

  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const acquired = await redis.set(lockKey, token, { nx: true, ex: 10 });
    if (acquired === 'OK') return token;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Could not acquire lock: ${lockKey}`);
}

async function releaseLock(lockKey: string, token: string | null) {
  if (!redis || !token) return;

  // Delete only our lock, preventing a slow request from deleting a newer lock
  // after the original ten-second lease has expired.
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    [lockKey],
    [token],
  );
}

export async function withDatabase<T>(
  operation: (database: { data: Database }) => T | Promise<T>,
): Promise<T> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
      await client.query('begin');
      try {
        const current = await client.query<{ data: Database }>(
          `select data from jester_app_state where key = 'main' for update`,
        );
        const data = normalizeDatabase(current.rows[0]?.data);
        const result = await operation({ data });
        await client.query(
          `insert into jester_app_state (key, data, updated_at)
           values ('main', $1::jsonb, now())
           on conflict (key) do update set data = excluded.data, updated_at = now()`,
          [JSON.stringify(data)],
        );
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      });
    } catch (error) {
      if (disablePostgresInDevelopment(error)) {
        // Dev: fell back to local store — continue below
      } else {
        // Production: Postgres is down but we can still serve from local
        // memory so the app doesn't 503. Matchmaking will be per-instance
        // (no cross-instance sharing) until Postgres recovers.
        console.error('Postgres unavailable, falling back to local store', error);
      }
    }
  }

  if (!redis) {
    // In production without Redis: use local store as a degraded fallback.
    // Matchmaking is per-instance (Vercel spins up many), so only players
    // hitting the same instance can be matched. Good enough to keep the app
    // alive while Postgres/Redis are being configured.
    if (process.env.NODE_ENV === 'production') {
      console.warn('Redis is not configured — using local in-memory store (per-instance only).');
    }
    // Guards against a dev-server hot reload keeping an older globalThis
    // object around from before a field (e.g. `intros`) was added here.
    localStore.intros ??= [];
    localStore.turnServers ??= [];
    localStore.turnProviders ??= [];
    localStore.users ??= [];
    return operation({ data: localStore });
  }

  const lockToken = await acquireLock(REDIS_LOCK_KEY);
  try {
    const data = (await redis.get<Database>(REDIS_DATA_KEY)) ?? {
      intros: [],
      turnServers: [],
      turnProviders: [],
      users: [],
    };
    data.intros ??= [];
    data.turnServers ??= [];
    data.turnProviders ??= [];
    data.users ??= [];
    const result = await operation({ data });
    await redis.set(REDIS_DATA_KEY, data, { ex: 60 * 60 });
    return result;
  } finally {
    await releaseLock(REDIS_LOCK_KEY, lockToken);
  }
}

// Matchmaking index: which rooms are open/full. Kept separate from per-room
// signaling data (below) so joining/leaving never contends with the 400ms
// polling loop, and vice versa.
export async function withRoomIndex<T>(
  operation: (rooms: RoomRecord[]) => T | Promise<T>,
): Promise<T> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
      await client.query('begin');
      try {
        await client.query(`select data from jester_app_state where key = 'room_index_lock' for update`);
        const current = await client.query<{
          id: string;
          participant_ids: string[];
          created_at: string | number;
        }>('select id, participant_ids, created_at from jester_rooms order by created_at for update');
        const rooms = current.rows.map(rowToRoom);
        const result = await operation(rooms);
        const keepIds = rooms.map((room) => room.id);
        if (keepIds.length > 0) {
          await client.query('delete from jester_rooms where not (id = any($1::text[]))', [keepIds]);
        } else {
          await client.query('delete from jester_rooms');
        }
        for (const room of rooms) {
          await client.query(
            `insert into jester_rooms (id, participant_ids, created_at)
             values ($1, $2::jsonb, $3)
             on conflict (id) do update
             set participant_ids = excluded.participant_ids, created_at = excluded.created_at`,
            [room.id, JSON.stringify(room.participantIds), room.createdAt],
          );
        }
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      });
    } catch (error) {
      if (disablePostgresInDevelopment(error)) {
        // Dev: fell back to local store
      } else {
        console.error('Postgres unavailable for room index, falling back to local store', error);
      }
    }
  }

  if (!redis) {
    return operation(localRooms);
  }

  const lockToken = await acquireLock(REDIS_ROOM_INDEX_LOCK_KEY);
  try {
    const rooms = (await redis.get<RoomRecord[]>(REDIS_ROOM_INDEX_KEY)) ?? [];
    const result = await operation(rooms);
    await redis.set(REDIS_ROOM_INDEX_KEY, rooms, { ex: 60 * 60 });
    return result;
  } finally {
    await releaseLock(REDIS_ROOM_INDEX_LOCK_KEY, lockToken);
  }
}

// Per-room signaling data (participants + their queued messages), scoped to
// a single room and backed by plain atomic Redis operations — a hash field
// per participant and a message list per participant. Nothing here takes a
// lock: each participant only ever writes their own hash field and RPUSHes
// onto their peer's own list, so there's no read-modify-write race to guard
// against. This matters because GET (poll, every 400ms per participant) and
// POST (offer/answer/candidates/heartbeats) both hit this store constantly
// during a call — funneling that through one app-level lock per room (the
// previous design) serialized all of it behind a single mutex, and under
// real call load (ICE candidate bursts + bidirectional polling) the queue
// of waiters could outlast the lock's retry budget and throw.

export async function getRoomParticipants(roomId: string): Promise<ParticipantRecord[]> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
      const result = await client.query<{
        id: string;
        room_id: string;
        username: string;
        last_seen: string | number;
      }>(
        'select id, room_id, username, last_seen from jester_participants where room_id = $1',
        [roomId],
      );
      return result.rows.map(rowToParticipant);
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  if (!redis) {
    return [...getLocalRoom(roomId).participants.values()];
  }
  const raw = await redis.hgetall<Record<string, ParticipantRecord>>(roomParticipantsKey(roomId));
  return raw ? Object.values(raw) : [];
}

// Lightweight single-query lookup: find the other participant in a room.
// Used for in-memory SSE notification — no pruning, no deletes, just a read.
export async function findRoomOpponent(roomId: string, excludeId: string): Promise<ParticipantRecord | null> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
        const result = await client.query<{ id: string; room_id: string; username: string; last_seen: string | number }>(
          `SELECT id, room_id, username, last_seen FROM jester_participants
           WHERE room_id = $1 AND id != $2
           LIMIT 1`,
          [roomId, excludeId],
        );
        return result.rows[0] ? rowToParticipant(result.rows[0]) : null;
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }
  // Fallback: local/Redis.
  const all = await getRoomParticipants(roomId);
  return all.find((p) => p.id !== excludeId) ?? null;
}

// Only ever called by a participant to write their own record, so concurrent
// callers never touch the same hash field.
export async function upsertParticipant(participant: ParticipantRecord): Promise<void> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      await withPostgresClient(async (client) => {
      await client.query(
        `insert into jester_participants (id, room_id, username, last_seen)
         values ($1, $2, $3, $4)
         on conflict (id) do update
         set room_id = excluded.room_id, username = excluded.username, last_seen = excluded.last_seen`,
        [participant.id, participant.roomId, participant.username, participant.lastSeen],
      );
      });
      return;
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  if (!redis) {
    getLocalRoom(participant.roomId).participants.set(participant.id, participant);
    return;
  }
  const key = roomParticipantsKey(participant.roomId);
  await redis.hset(key, { [participant.id]: participant });
  await redis.expire(key, ROOM_KEY_TTL_SECONDS);
}

export async function removeParticipant(roomId: string, participantId: string): Promise<void> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      await withPostgresClient(async (client) => {
      await client.query('delete from jester_participants where room_id = $1 and id = $2', [
        roomId,
        participantId,
      ]);
      await client.query('delete from jester_messages where room_id = $1 and participant_id = $2', [
        roomId,
        participantId,
      ]);
      });
      return;
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  if (!redis) {
    const room = getLocalRoom(roomId);
    room.participants.delete(participantId);
    room.messages.delete(participantId);
    return;
  }
  await Promise.all([
    redis.hdel(roomParticipantsKey(roomId), participantId),
    redis.del(roomMessagesKey(roomId, participantId)),
  ]);
}

// --- Batched operations: single Postgres connection + transaction per call ---
// These replace the pattern of calling getRoomParticipants / upsertParticipant /
// drainMessages / pushMessage separately (each opens its own connection). On a
// remote pooler with limited connections, batching 3-4 queries into 1 connection
// is the difference between "works" and "times out at 5s".

export async function heartbeatAndDrain(
  roomId: string,
  participantId: string,
): Promise<{ messages: SignalMessage[] } | null> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
        await client.query('BEGIN');
        try {
          const now = Date.now();
          // Check participant exists + refresh lastSeen in one query.
          const res = await client.query<{ id: string }>(
            `UPDATE jester_participants SET last_seen = $1
             WHERE id = $2 AND room_id = $3
             RETURNING id`,
            [now, participantId, roomId],
          );
          if (res.rowCount === 0) {
            await client.query('ROLLBACK');
            return null;
          }
          // Drain messages atomically.
          const msgs = await client.query<{ id: string; message: SignalMessage }>(
            `SELECT id, message FROM jester_messages
             WHERE room_id = $1 AND participant_id = $2
             ORDER BY id FOR UPDATE`,
            [roomId, participantId],
          );
          const ids = msgs.rows.map((r) => r.id);
          if (ids.length > 0) {
            await client.query('DELETE FROM jester_messages WHERE id = ANY($1::bigint[])', [ids]);
          }
          await client.query('COMMIT');
          return { messages: msgs.rows.map((r) => r.message) };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  // Fallback: local/Redis path uses existing individual functions.
  const participants = await getRoomParticipants(roomId);
  const participant = participants.find((c) => c.id === participantId);
  if (!participant) return null;
  await upsertParticipant({ ...participant, lastSeen: Date.now() });
  const messages = await drainMessages(roomId, participantId);
  return { messages };
}

export async function heartbeatAndPush(
  roomId: string,
  participantId: string,
  message: SignalMessage,
): Promise<{ status: 'ok' | 'not_found'; opponentId?: string }> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
        await client.query('BEGIN');
        try {
          const now = Date.now();
          // Refresh lastSeen + find the other participant in one query.
          const other = await client.query<{ id: string }>(
            `SELECT p.id FROM jester_participants p
             WHERE p.room_id = $1 AND p.id != $2
             AND p.last_seen > $3
             LIMIT 1`,
            [roomId, participantId, now - PARTICIPANT_TTL_MS],
          );
          // Check sender exists + heartbeat.
          const res = await client.query<{ id: string }>(
            `UPDATE jester_participants SET last_seen = $1
             WHERE id = $2 AND room_id = $3
             RETURNING id`,
            [now, participantId, roomId],
          );
          if (res.rowCount === 0) {
            await client.query('ROLLBACK');
            return { status: 'not_found' as const };
          }
          const opponentId = (other.rowCount && other.rowCount > 0) ? other.rows[0].id : undefined;
          // Push message to opponent if they exist.
          if (opponentId) {
            await client.query(
              'INSERT INTO jester_messages (room_id, participant_id, message) VALUES ($1, $2, $3::jsonb)',
              [roomId, opponentId, JSON.stringify(message)],
            );
          }
          await client.query('COMMIT');
          return { status: 'ok' as const, opponentId };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  // Fallback: local/Redis path.
  const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
  const participant = participants.find((c) => c.id === participantId);
  if (!participant) return { status: 'not_found' as const };
  await upsertParticipant({ ...participant, lastSeen: Date.now() });
  const other = participants.find((c) => c.id !== participantId);
  if (other) await pushMessage(roomId, other.id, message);
  return { status: 'ok' as const, opponentId: other?.id };
}

// Drops participants that haven't polled/posted inside the TTL and returns
// the ones still live. Best-effort and idempotent — concurrent callers
// pruning the same stale entry just both no-op — so this needs no lock.
export async function pruneRoomParticipants(
  roomId: string,
  cutoffMs: number,
): Promise<ParticipantRecord[]> {
  const all = await getRoomParticipants(roomId);
  const live = all.filter((participant) => participant.lastSeen > cutoffMs);
  const stale = all.filter((participant) => participant.lastSeen <= cutoffMs);
  if (stale.length > 0) {
    await Promise.all(stale.map((participant) => removeParticipant(roomId, participant.id)));
  }
  return live;
}

export async function pushMessage(
  roomId: string,
  participantId: string,
  message: SignalMessage,
): Promise<void> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      await withPostgresClient(async (client) => {
      await client.query(
        'insert into jester_messages (room_id, participant_id, message) values ($1, $2, $3::jsonb)',
        [roomId, participantId, JSON.stringify(message)],
      );
      });
      return;
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  if (!redis) {
    const room = getLocalRoom(roomId);
    const queue = room.messages.get(participantId) ?? [];
    queue.push(message);
    room.messages.set(participantId, queue);
    return;
  }
  const key = roomMessagesKey(roomId, participantId);
  await redis.rpush(key, message);
  await redis.expire(key, ROOM_KEY_TTL_SECONDS);
}

// Atomically returns and clears a participant's queued messages in one round
// trip (LRANGE + DEL via a Lua script), so a poll can never see a message
// twice or drop one to a race with a concurrent poll.
const DRAIN_MESSAGES_SCRIPT = `
local msgs = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return msgs
`;

export async function drainMessages(roomId: string, participantId: string): Promise<SignalMessage[]> {
  if (pgPool && !globalPg.__jesterPgDisabled) {
    try {
      return await withPostgresClient(async (client) => {
      await client.query('begin');
      try {
        const result = await client.query<{ id: string; message: SignalMessage }>(
          `select id, message
           from jester_messages
           where room_id = $1 and participant_id = $2
           order by id
           for update`,
          [roomId, participantId],
        );
        const ids = result.rows.map((row) => row.id);
        if (ids.length > 0) {
          await client.query('delete from jester_messages where id = any($1::bigint[])', [ids]);
        }
        await client.query('commit');
        return result.rows.map((row) => row.message);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      });
    } catch (error) {
      if (!globalPg.__jesterPgDisabled) throw error;
    }
  }

  if (!redis) {
    const room = getLocalRoom(roomId);
    const queue = room.messages.get(participantId) ?? [];
    room.messages.set(participantId, []);
    return queue;
  }
  const key = roomMessagesKey(roomId, participantId);
  const messages = await redis.eval<[], SignalMessage[]>(DRAIN_MESSAGES_SCRIPT, [key], []);
  return messages ?? [];
}
