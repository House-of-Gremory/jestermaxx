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
import { getSupabase, signalChannelTopic } from '@/lib/supabase-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// With SSE, lastSeen is refreshed ~10x/sec on the server side. 12s without a
// heartbeat means the tab is really gone.
const PARTICIPANT_TTL_MS = 12_000;

// How often the server-side SSE loop checks for new messages and refreshes
// lastSeen. 100ms keeps message delivery near-instant without hammering the DB.
const SSE_TICK_MS = 100;

// Send a SSE comment (": heartbeat\n\n") every 5s so proxies / load balancers
// don't close the idle connection.
const SSE_HEARTBEAT_MS = 5_000;

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
  } catch {
    // Non-fatal: the index self-heals on next join.
  }
}

// Best-effort Realtime broadcast. Fails silently when Supabase is not
// configured — the queue-based fallback still works.
async function broadcastSignal(participantId: string, message: SignalMessage) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.channel(signalChannelTopic(participantId)).send({
      type: 'broadcast',
      event: 'signal',
      payload: message,
    });
  } catch {
    // Non-fatal: the SSE tick-loop will deliver the message on the next poll.
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
        void broadcastSignal(existingParticipant.id, { type: 'peer-joined', payload: { username } });
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
    if (otherParticipant) {
      await pushMessage(roomId, otherParticipant.id, message);
      void broadcastSignal(otherParticipant.id, message);
    }

    if (message.type === 'bye') {
      await removeParticipant(roomId, participantId);
      await releaseRoomFromIndex(roomId, participantId);
    }

    return Response.json({ ok: true });
  } catch {
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

  // Validate the participant exists before opening the stream so the client
  // gets an immediate error instead of a hanging connection.
  try {
    const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
    const participant = participants.find((c) => c.id === participantId);
    if (!participant) {
      if (participants.length === 0) void releaseRoomFromIndex(roomId);
      return Response.json({ messages: [] }, { status: 404 });
    }
    await upsertParticipant({ ...participant, lastSeen: Date.now() });
  } catch {
    return Response.json({ messages: [] });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        if (!closed) controller.enqueue(encoder.encode(data));
      };

      // Immediately flush any messages that were already queued (e.g. the
      // peer-joined that triggered this SSE connection).
      void (async () => {
        try {
          const msgs = await drainMessages(roomId, participantId);
          for (const m of msgs) send(`data: ${JSON.stringify(m)}\n\n`);
        } catch {
          // Transient error — the tick loop will retry.
        }
      })();

      const tick = async () => {
        if (closed) return;
        try {
          const participants = await pruneRoomParticipants(roomId, Date.now() - PARTICIPANT_TTL_MS);
          const participant = participants.find((c) => c.id === participantId);

          if (!participant) {
            send('event: expired\ndata: {}\n\n');
            controller.close();
            return;
          }

          await upsertParticipant({ ...participant, lastSeen: Date.now() });
          const msgs = await drainMessages(roomId, participantId);
          for (const m of msgs) send(`data: ${JSON.stringify(m)}\n\n`);
        } catch {
          // Transient error — the tick loop will retry.
        }

        if (!closed) timer = setTimeout(tick, SSE_TICK_MS);
      };

      timer = setTimeout(tick, SSE_TICK_MS);

      // Keep-alive comment so proxies don't kill the connection.
      heartbeat = setInterval(() => send(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
    },

    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  // Abort the stream when the client disconnects.
  request.signal.addEventListener('abort', () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    try { stream.cancel(); } catch { /* already closed */ }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
