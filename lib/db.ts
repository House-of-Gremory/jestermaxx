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
  if (!redis) {
    return [...getLocalRoom(roomId).participants.values()];
  }
  const raw = await redis.hgetall<Record<string, ParticipantRecord>>(roomParticipantsKey(roomId));
  return raw ? Object.values(raw) : [];
}

// Only ever called by a participant to write their own record, so concurrent
// callers never touch the same hash field.
export async function upsertParticipant(participant: ParticipantRecord): Promise<void> {
  if (!redis) {
    getLocalRoom(participant.roomId).participants.set(participant.id, participant);
    return;
  }
  const key = roomParticipantsKey(participant.roomId);
  await redis.hset(key, { [participant.id]: participant });
  await redis.expire(key, ROOM_KEY_TTL_SECONDS);
}

export async function removeParticipant(roomId: string, participantId: string): Promise<void> {
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
