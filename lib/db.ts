import { Redis } from '@upstash/redis';

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

export type Database = {
  rooms: RoomRecord[];
  participants: ParticipantRecord[];
  intros: IntroRecord[];
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;
const REDIS_DATA_KEY = 'jestermaxing:signaling';
const REDIS_LOCK_KEY = 'jestermaxing:signaling:lock';

// Local development fallback. Vercel instances do not share process memory,
// so production requires the shared Redis store configured above.
const globalStore = globalThis as unknown as { __jesterDb?: Database };
const localStore: Database = (globalStore.__jesterDb ??= { rooms: [], participants: [], intros: [] });

async function acquireLock() {
  if (!redis) return null;

  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const acquired = await redis.set(REDIS_LOCK_KEY, token, { nx: true, ex: 10 });
    if (acquired === 'OK') return token;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Could not acquire signaling store lock');
}

async function releaseLock(token: string | null) {
  if (!redis || !token) return;

  // Delete only our lock, preventing a slow request from deleting a newer lock
  // after the original ten-second lease has expired.
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    [REDIS_LOCK_KEY],
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
    return operation({ data: localStore });
  }

  const lockToken = await acquireLock();
  try {
    const data = (await redis.get<Database>(REDIS_DATA_KEY)) ?? {
      rooms: [],
      participants: [],
      intros: [],
    };
    data.intros ??= [];
    const result = await operation({ data });
    await redis.set(REDIS_DATA_KEY, data, { ex: 60 * 60 });
    return result;
  } finally {
    await releaseLock(lockToken);
  }
}
