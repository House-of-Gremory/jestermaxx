import {
  drainMessages,
  pruneRoomParticipants,
  pushMessage,
  removeParticipant,
  upsertParticipant,
  withRoomIndex,
  type ParticipantRecord,
  type SignalMessage,
} from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// A live client polls every ~400ms (refreshing lastSeen), so 12s without a
// single successful poll means the tab is really gone. Shorter than the old 30s
// so ghost participants stop occupying rooms and blocking new matches.
const PARTICIPANT_TTL_MS = 12_000;

// Best-effort: drop a room from the matchmaking index once it's actually
// empty, so it stops being counted as "full" or getting matched into. Safe
// to skip on failure — the index self-heals the next time join() encounters
// a stale full room.
async function releaseRoomFromIndex(roomId: string, participantId?: string) {
  try {
    await withRoomIndex((rooms) => {
      const room = rooms.find((candidate) => candidate.id === roomId);
      if (!room) return;
      if (participantId) {
        room.participantIds = room.participantIds.filter((id) => id !== participantId);
      }
      if (room.participantIds.length === 0) {
        const index = rooms.indexOf(room);
        rooms.splice(index, 1);
      }
    });
  } catch (error) {
    console.error('Failed to release room from matchmaking index', roomId, error);
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    action?: string;
    username?: string;
    roomId?: string;
    participantId?: string;
    message?: SignalMessage;
    excludeRoomId?: string;
  };

  if (body.action === 'join') {
    const username = body.username?.trim();
    if (!username || username.length > 32) {
      return Response.json({ error: 'Username must be 1-32 characters' }, { status: 400 });
    }

    const participantId = createId('person');

    // Find the first room with a free slot. `excludeRoomId` is the room the
    // caller just left via "Next player" — skipping it stops them from being
    // immediately rematched with the same person they were just paired with.
    const roomId = await withRoomIndex((rooms) => {
      let room = rooms.find(
        (candidate) => candidate.participantIds.length < 2 && candidate.id !== body.excludeRoomId,
      );
      if (!room) {
        room = { id: createId('room'), participantIds: [], createdAt: Date.now() };
        rooms.push(room);
      }
      room.participantIds.push(participantId);
      return room.id;
    });

    const participant: ParticipantRecord = {
      id: participantId,
      roomId,
      username,
      lastSeen: Date.now(),
    };

    const existingParticipants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
    const existingParticipant = existingParticipants[0] as ParticipantRecord | undefined;
    await upsertParticipant(participant);
    if (existingParticipant) {
      await pushMessage(roomId, existingParticipant.id, { type: 'peer-joined', payload: { username } });
    }
    const opponentUsername = existingParticipant?.username;

    return Response.json({
      roomId,
      participantId,
      username,
      waiting: opponentUsername === undefined,
      // Lets the second joiner show the first joiner's intro reel
      // immediately, without waiting on a signaling round trip.
      opponentUsername,
    });
  }

  if (!body.roomId || !body.participantId || !body.message) {
    return Response.json({ error: 'Invalid signaling request' }, { status: 400 });
  }

  const { roomId, participantId, message } = body;

  const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
  const participant = participants.find((candidate) => candidate.id === participantId);
  if (!participant) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }

  await upsertParticipant({ ...participant, lastSeen: Date.now() });

  const otherParticipant = participants.find((candidate) => candidate.id !== participantId);
  if (otherParticipant) await pushMessage(roomId, otherParticipant.id, message);

  if (message.type === 'bye') {
    await removeParticipant(roomId, participantId);
    await releaseRoomFromIndex(roomId, participantId);
  }

  return Response.json({ ok: true });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');

  if (!roomId || !participantId) {
    return Response.json({ messages: [] }, { status: 404 });
  }

  const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
  const participant = participants.find((candidate) => candidate.id === participantId);

  if (!participant) {
    // The participant expired (or the room emptied out) without a graceful
    // 'bye' — reconcile the matchmaking index so the slot isn't stuck "full".
    if (participants.length === 0) void releaseRoomFromIndex(roomId);
    return Response.json({ messages: [] }, { status: 404 });
  }

  await upsertParticipant({ ...participant, lastSeen: Date.now() });
  const messages = await drainMessages(roomId, participantId);
  return Response.json({ messages });
}
