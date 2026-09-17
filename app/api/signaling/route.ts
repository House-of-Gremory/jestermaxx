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
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (body.action === 'join') {
      const username = (body.username as string)?.trim();
      if (!username || username.length > 32) {
        return Response.json({ error: 'Username must be 1-32 characters' }, { status: 400 });
      }

      const participantId = createId('person');

      const cutoff = Date.now() - PARTICIPANT_TTL_MS;
      const { roomId, existingParticipant } = await withRoomIndex(async (rooms) => {
        for (let i = 0; i < rooms.length; i += 1) {
          const candidate = rooms[i];
          if (candidate.id === (body.excludeRoomId as string)) continue;

          const live = await pruneRoomParticipants(candidate.id, cutoff);
          candidate.participantIds = live.map((p) => p.id);

          if (candidate.participantIds.length === 0) {
            rooms.splice(i, 1);
            i -= 1;
            continue;
          }
          if (candidate.participantIds.length < 2) {
            candidate.participantIds.push(participantId);
            return { roomId: candidate.id, existingParticipant: live[0] as ParticipantRecord | undefined };
          }
        }

        const room: (typeof rooms)[number] = {
          id: createId('room'),
          participantIds: [participantId],
          createdAt: Date.now(),
        };
        rooms.push(room);
        return { roomId: room.id, existingParticipant: undefined };
      });

      const participant: ParticipantRecord = {
        id: participantId,
        roomId,
        username,
        lastSeen: Date.now(),
      };

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
        opponentUsername,
      });
    }

    if (!body.roomId || !body.participantId || !body.message) {
      return Response.json({ error: 'Invalid signaling request' }, { status: 400 });
    }

    const roomId = body.roomId as string;
    const participantId = body.participantId as string;
    const message = body.message as SignalMessage;

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
  } catch (error) {
    console.error('Signaling POST failed', error);
    return Response.json(
      { error: 'Signaling temporarily unavailable' },
      { status: 503 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');

  if (!roomId || !participantId) {
    return Response.json({ messages: [] }, { status: 404 });
  }

  try {
    const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
    const participant = participants.find((candidate) => candidate.id === participantId);

    if (!participant) {
      if (participants.length === 0) void releaseRoomFromIndex(roomId);
      return Response.json({ messages: [] }, { status: 404 });
    }

    await upsertParticipant({ ...participant, lastSeen: Date.now() });
    const messages = await drainMessages(roomId, participantId);
    return Response.json({ messages });
  } catch (error) {
    console.error('Signaling GET failed', error);
    return Response.json({ messages: [] }, { status: 503 });
  }
}
