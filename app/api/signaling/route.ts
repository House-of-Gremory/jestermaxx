import {
  heartbeatAndDrain,
  heartbeatAndPush,
  pruneRoomParticipants,
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

const PARTICIPANT_TTL_MS = 12_000;

// Server-side SSE tick: how often to poll DB for messages as a fallback.
// When POST pushes a message, it can also notify the SSE stream directly
// (see in-memory pub/sub below), but the DB poll handles cross-instance delivery.
const SSE_TICK_MS = 500;
const SSE_HEARTBEAT_MS = 15_000;

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
    // Non-fatal.
  }
}

// ── In-memory pub/sub for same-instance SSE delivery ──────────────────────
// When a POST pushes a message for participant X, it writes to the DB *and*
// pokes this map so the SSE handler for X can push immediately without waiting
// for the next DB poll tick. This cuts latency from ~500ms to <1ms when both
// participants land on the same Vercel function instance (common for dev, and
// frequent in prod due to connection affinity). Cross-instance delivery is
// handled by the DB poll fallback.
const sseSubscribers = new Map<string, Set<(msg: SignalMessage) => void>>();

function notifySSE(participantId: string, message: SignalMessage) {
  const subs = sseSubscribers.get(participantId);
  if (subs) {
    for (const fn of subs) fn(message);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────

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
        await upsertParticipant(existingParticipant);
        const peerJoined: SignalMessage = { type: 'peer-joined', payload: { username } };
        await heartbeatAndPush(roomId, existingParticipant.id, peerJoined);
        notifySSE(existingParticipant.id, peerJoined);
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

    if (message.type === 'bye') {
      // Bye: remove participant, release room, and notify opponent.
      await removeParticipant(roomId, participantId);
      await releaseRoomFromIndex(roomId, participantId);
      return Response.json({ ok: true });
    }

    // Single-transaction heartbeat + message push.
    const result = await heartbeatAndPush(roomId, participantId, message);
    if (result.status === 'not_found') {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }

    // Instant in-memory SSE notification — no extra DB query needed.
    if (result.opponentId) notifySSE(result.opponentId, message);

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: 'Signaling temporarily unavailable' },
      { status: 503 },
    );
  }
}

// ── GET (SSE) ─────────────────────────────────────────────────────────────
// One long-lived connection per participant replaces the 400ms polling loop.
// The server holds the connection open and pushes messages as they arrive,
// either via in-memory notification (instant) or DB poll (every 500ms fallback).

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');

  if (!roomId || !participantId) {
    return Response.json({ messages: [] }, { status: 404 });
  }

  // Validate participant exists before opening SSE stream.
  try {
    const result = await heartbeatAndDrain(roomId, participantId);
    if (!result) {
      return Response.json({ messages: [] }, { status: 404 });
    }

    // Participant is valid. Open SSE stream.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let onNotify: ((msg: SignalMessage) => void) | undefined;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: string) => {
          if (!closed) controller.enqueue(encoder.encode(data));
        };

        // Send messages already drained from the initial validation.
        for (const msg of result.messages) {
          send(`data: ${JSON.stringify(msg)}\n\n`);
        }

        // Register for in-memory notifications (instant delivery).
        const subs = sseSubscribers.get(participantId) ?? new Set();
        onNotify = (msg: SignalMessage) => send(`data: ${JSON.stringify(msg)}\n\n`);
        subs.add(onNotify);
        sseSubscribers.set(participantId, subs);

        // DB poll fallback for cross-instance delivery or missed notifications.
        const tick = async () => {
          if (closed) return;
          try {
            const res = await heartbeatAndDrain(roomId, participantId);
            if (!res) {
              send('event: expired\ndata: {}\n\n');
              controller.close();
              closed = true;
              if (timer) clearTimeout(timer);
              if (heartbeat) clearInterval(heartbeat);
              if (onNotify) sseSubscribers.get(participantId)?.delete(onNotify);
              return;
            }
            for (const msg of res.messages) {
              send(`data: ${JSON.stringify(msg)}\n\n`);
            }
          } catch {
            // Transient error — the next tick will retry.
          }
          if (!closed) timer = setTimeout(tick, SSE_TICK_MS);
        };

        timer = setTimeout(tick, SSE_TICK_MS);

        // Keep-alive so proxies / load balancers don't kill the connection.
        heartbeat = setInterval(() => send(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
      },

      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    request.signal.addEventListener('abort', () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (onNotify) sseSubscribers.get(participantId)?.delete(onNotify);
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch {
    return Response.json({ messages: [] });
  }
}
