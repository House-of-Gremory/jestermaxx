import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JSONFile } from 'lowdb/node';
import { Low } from 'lowdb';

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

const databaseFile = path.join(process.cwd(), 'data', 'jestermaxing.json');
const defaultData: Database = { rooms: [], participants: [] };

let databasePromise: Promise<Low<Database>> | undefined;
let writeQueue = Promise.resolve();

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      await mkdir(path.dirname(databaseFile), { recursive: true });
      const database = new Low(new JSONFile<Database>(databaseFile), defaultData);
      await database.read();
      database.data ||= defaultData;
      return database;
    })();
  }

  return databasePromise;
}

// Route handlers can run at the same time. Serializing reads and writes keeps
// two users joining simultaneously from overwriting one another in the JSON
// file. This is intentionally small and can later be replaced by a real DB.
export function withDatabase<T>(operation: (database: Low<Database>) => Promise<T> | T) {
  const currentOperation = writeQueue.then(async () => {
    const database = await getDatabase();
    await database.read();
    database.data ||= defaultData;
    const result = await operation(database);
    await database.write();
    return result;
  });

  writeQueue = currentOperation.then(
    () => undefined,
    () => undefined,
  );

  return currentOperation;
}
