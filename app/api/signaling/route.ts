import { withDatabase, type Database, type SignalMessage } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function removeExpiredParticipants(database: { data: Database }) {
  const cutoff = Date.now() - 30_000;
  const expiredIds = new Set(
    database.data.participants
      .filter((participant) => participant.lastSeen <= cutoff)
      .map((participant) => participant.id),
  );

  database.data.participants = database.data.participants.filter(
    (participant) => !expiredIds.has(participant.id),
  );

  for (const room of database.data.rooms) {
    room.participantIds = room.participantIds.filter((participantId) => !expiredIds.has(participantId));
  }

  database.data.rooms = database.data.rooms.filter(
    (room) => room.participantIds.length > 0,
  );
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    action?: string;
    username?: string;
    roomId?: string;
    participantId?: string;
    message?: SignalMessage;
  };

  return withDatabase((database) => {
    removeExpiredParticipants(database);

    if (body.action === 'join') {
      const username = body.username?.trim();
      if (!username || username.length > 32) {
        return Response.json({ error: 'Username must be 1-32 characters' }, { status: 400 });
      }

      // Find the first room with one person. If every room is full, create the
      // next room. This creates pairs in order: 1+2, 3+4, 5+6, and so on.
      let room = database.data.rooms.find(
        (candidate) => candidate.participantIds.length < 2,
      );
      if (!room) {
        room = {
          id: createId('room'),
          participantIds: [],
          createdAt: Date.now(),
        };
        database.data.rooms.push(room);
      }

      const participant = {
        id: createId('person'),
        roomId: room.id,
        username,
        messages: [] as SignalMessage[],
        lastSeen: Date.now(),
      };
      const existingParticipant = database.data.participants.find(
        (candidate) => candidate.id === room?.participantIds[0],
      );

      room.participantIds.push(participant.id);
      database.data.participants.push(participant);

      if (existingParticipant) existingParticipant.messages.push({ type: 'peer-joined' });

      return Response.json({
        roomId: room.id,
        participantId: participant.id,
        username,
        waiting: room.participantIds.length === 1,
      });
    }

    if (!body.roomId || !body.participantId || !body.message) {
      return Response.json({ error: 'Invalid signaling request' }, { status: 400 });
    }

    const participant = database.data.participants.find(
      (candidate) => candidate.id === body.participantId && candidate.roomId === body.roomId,
    );
    const room = database.data.rooms.find((candidate) => candidate.id === body.roomId);
    if (!participant || !room) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }

    participant.lastSeen = Date.now();
    const otherParticipant = database.data.participants.find(
      (candidate) => candidate.roomId === room.id && candidate.id !== participant.id,
    );
    if (otherParticipant) otherParticipant.messages.push(body.message);

    if (body.message.type === 'bye') {
      room.participantIds = room.participantIds.filter((id) => id !== participant.id);
      database.data.participants = database.data.participants.filter(
        (candidate) => candidate.id !== participant.id,
      );
      if (room.participantIds.length === 0) {
        database.data.rooms = database.data.rooms.filter((candidate) => candidate.id !== room.id);
      }
    }

    return Response.json({ ok: true });
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');

  return withDatabase((database) => {
    removeExpiredParticipants(database);
    const participant = database.data.participants.find(
      (candidate) => candidate.id === participantId && candidate.roomId === roomId,
    );

    if (!participant) return Response.json({ messages: [] }, { status: 404 });

    participant.lastSeen = Date.now();
    const messages = participant.messages.splice(0, participant.messages.length);
    return Response.json({ messages });
  });
}
