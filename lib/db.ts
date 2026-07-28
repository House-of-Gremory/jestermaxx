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

export type Database = {
  rooms: RoomRecord[];
  participants: ParticipantRecord[];
};

// In-memory signaling store.
//
// Why not the previous lowdb/JSON-file store: every request read AND wrote the
// file, which serialized all traffic behind disk I/O and made matchmaking slow
// and racey under real load. Signaling data is short-lived and disposable, so it
// belongs in memory.
//
// It is kept on `globalThis` so the same object survives hot-reloads in `next
// dev` and every request within ONE Node process (a VPS, a container, `next
// start`, Render, Railway, Fly, etc.).
//
// IMPORTANT — multi-instance hosting: on serverless/edge platforms that run more
// than one instance (e.g. Vercel by default), each instance holds its OWN copy
// of this object, so two users routed to different instances will NOT see each
// other and can never match. For reliable multi-user matchmaking either deploy
// as a SINGLE always-on instance, or replace this module with a shared store
// (Redis / Postgres). The exported API below is all the rest of the app uses, so
// only this file changes when you swap in a real database.
const globalStore = globalThis as unknown as { __jesterDb?: Database };
const store: Database = (globalStore.__jesterDb ??= { rooms: [], participants: [] });

// The store is a plain object mutated synchronously. Node runs each request
// handler to completion without yielding on shared memory, so no file lock or
// write queue is needed. Kept as a function so call sites don't change if this
// is later swapped for an async/remote store.
export function withDatabase<T>(operation: (database: { data: Database }) => T): T {
  return operation({ data: store });
}
