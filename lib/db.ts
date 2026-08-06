import { Redis } from '@upstash/redis';
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
  messages: SignalMessage[];
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

// Admin/config data only (intros, TURN servers/providers) — low-frequency,
// shared under one key/lock. Room matchmaking and signaling messages live in
// their own stores below so the 400ms polling hot path never contends with
// this or with other rooms (see withRoomIndex/withRoom).
export type Database = {
  intros: IntroRecord[];
  turnServers: TurnServerRecord[];
  turnProviders: TurnProviderRecord[];
};

// Per-room signaling data: the participants currently in a room and their
// queued messages.
export type RoomData = {
  participants: ParticipantRecord[];
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;
const REDIS_DATA_KEY = 'jestermaxing:signaling';
const REDIS_LOCK_KEY = 'jestermaxing:signaling:lock';

// Matchmaking index: which rooms exist and how many participants each has.
// Touched only on join/leave, never on the polling hot path.
const REDIS_ROOM_INDEX_KEY = 'jestermaxing:signaling:rooms';
const REDIS_ROOM_INDEX_LOCK_KEY = 'jestermaxing:signaling:rooms:lock';

function roomDataKey(roomId: string) {
  return `jestermaxing:signaling:room:${roomId}`;
}
function roomLockKey(roomId: string) {
  return `jestermaxing:signaling:room:${roomId}:lock`;
}

// Local development fallback. Vercel instances do not share process memory,
// so production requires the shared Redis store configured above.
const globalStore = globalThis as unknown as {
  __jesterDb?: Database;
  __jesterRooms?: RoomRecord[];
  __jesterRoomData?: Map<string, RoomData>;
};
const localStore: Database = (globalStore.__jesterDb ??= {
  intros: [],
  turnServers: [],
  turnProviders: [],
});
const localRooms: RoomRecord[] = (globalStore.__jesterRooms ??= []);
const localRoomData: Map<string, RoomData> = (globalStore.__jesterRoomData ??= new Map());

// A single-attempt, non-retrying lock (unlike the read-modify-write lock
// below, which retries). Used to let multiple server instances race to claim
// a piece of periodic work — e.g. one wall-clock time bucket — without
// duplicating it. Returns true if this call won the lock.
export async function tryAcquireLock(key: string, ttlSeconds: number): Promise<boolean> {
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
  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
      );
    }
    // Guards against a dev-server hot reload keeping an older globalThis
    // object around from before a field (e.g. `intros`) was added here.
    localStore.intros ??= [];
    localStore.turnServers ??= [];
    localStore.turnProviders ??= [];
    return operation({ data: localStore });
  }

  const lockToken = await acquireLock(REDIS_LOCK_KEY);
  try {
    const data = (await redis.get<Database>(REDIS_DATA_KEY)) ?? {
      intros: [],
      turnServers: [],
      turnProviders: [],
    };
    data.intros ??= [];
    data.turnServers ??= [];
    data.turnProviders ??= [];
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
// a single room's own Redis key/lock. Concurrent matches never lock against
// each other, and a room's own 400ms polling never touches the matchmaking
// index or the unrelated admin/config data above.
export async function withRoom<T>(
  roomId: string,
  operation: (room: RoomData) => T | Promise<T>,
): Promise<T> {
  if (!redis) {
    const room = localRoomData.get(roomId) ?? { participants: [] };
    const result = await operation(room);
    localRoomData.set(roomId, room);
    return result;
  }

  const dataKey = roomDataKey(roomId);
  const lockKey = roomLockKey(roomId);
  const lockToken = await acquireLock(lockKey);
  try {
    const room = (await redis.get<RoomData>(dataKey)) ?? { participants: [] };
    const result = await operation(room);
    if (room.participants.length === 0) {
      await redis.del(dataKey);
    } else {
      await redis.set(dataKey, room, { ex: 60 * 60 });
    }
    return result;
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}
