'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';

type SignalMessage =
  | { type: 'peer-joined' | 'bye' }
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit };

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// How often the client polls for signaling messages. Lower = faster handshake
// (and faster ghost cleanup, since each poll refreshes lastSeen) at the cost of
// more requests. 400ms keeps connection setup snappy without hammering.
const POLL_INTERVAL_MS = 400;

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch('/api/turn-credentials', { cache: 'no-store' });
    if (!response.ok) return FALLBACK_ICE_SERVERS;

    const data = (await response.json()) as { iceServers?: RTCIceServer[] };
    return data.iceServers?.length ? data.iceServers : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

// Try progressively weaker media constraints so a locked/absent camera does not
// abort the call. Returns null when no device is usable (view-only participant).
async function getLocalStream(
  setStatus: (message: string) => void,
): Promise<MediaStream | null> {
  const attempts: MediaStreamConstraints[] = [
    { video: true, audio: true },
    { video: true, audio: false },
    { video: false, audio: true },
  ];

  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      console.warn('getUserMedia failed for', constraints, (error as Error).name);
    }
  }

  setStatus('No camera or microphone available — joining as a viewer.');
  return null;
}

export default function VideoCall() {
  const [usernameInput, setUsernameInput] = useState('');
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('');
  // Bumping this re-runs the connection effect without leaving the call screen,
  // which is how "Next player" tears down the current peer and finds a new one.
  const [sessionId, setSessionId] = useState(0);
  const [connected, setConnected] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  // The room a "Next player" click is leaving, so the server won't rematch it.
  const excludeRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!username) return;

    stoppedRef.current = false;
    pendingCandidatesRef.current = [];
    setConnected(false);
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    async function sendSignal(message: SignalMessage) {
      const participantId = participantIdRef.current;
      const roomId = roomIdRef.current;
      if (!participantId || !roomId) return;

      await fetch('/api/signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId, roomId, message }),
      });
    }

    function sendByeBeacon() {
      const participantId = participantIdRef.current;
      const roomId = roomIdRef.current;
      if (!participantId || !roomId) return;

      // A normal fetch() can be aborted mid-flight when the tab is closed or
      // refreshed, leaving a "ghost" participant that occupies the room. sendBeacon
      // is designed to reliably deliver during unload.
      const body = JSON.stringify({ participantId, roomId, message: { type: 'bye' } });
      navigator.sendBeacon('/api/signaling', new Blob([body], { type: 'application/json' }));
    }

    window.addEventListener('pagehide', sendByeBeacon);

    async function createOffer() {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await sendSignal({ type: 'offer', payload: offer });
    }

    async function flushPendingCandidates() {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      const candidates = pendingCandidatesRef.current.splice(0, pendingCandidatesRef.current.length);
      for (const candidate of candidates) {
        try {
          await peerConnection.addIceCandidate(candidate);
        } catch {
          // A stale/invalid candidate should not block the rest of the call.
        }
      }
    }

    async function handleSignal(message: SignalMessage) {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      if (message.type === 'peer-joined') {
        // The first person in every room is the caller. When the second person
        // joins, only that first person receives this event and creates offer.
        setStatus('Opponent found. Connecting…');
        await createOffer();
      } else if (message.type === 'offer') {
        await peerConnection.setRemoteDescription(message.payload);
        await flushPendingCandidates();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await sendSignal({ type: 'answer', payload: answer });
      } else if (message.type === 'answer') {
        await peerConnection.setRemoteDescription(message.payload);
        await flushPendingCandidates();
      } else if (message.type === 'candidate') {
        // Polling can deliver messages out of order, so a candidate may arrive
        // before the offer/answer that sets the remote description. Buffer it.
        if (peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(message.payload);
        } else {
          pendingCandidatesRef.current.push(message.payload);
        }
      } else if (message.type === 'bye') {
        // Opponent left the call. Clear their video and prompt to find a new one.
        setConnected(false);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        setStatus('Opponent left. Tap “Next player” to find someone new.');
      }
    }

    async function pollSignals() {
      const participantId = participantIdRef.current;
      const roomId = roomIdRef.current;
      if (stoppedRef.current || !participantId || !roomId) return;

      try {
        const response = await fetch(
          `/api/signaling?roomId=${encodeURIComponent(roomId)}&participantId=${encodeURIComponent(participantId)}`,
          { cache: 'no-store' },
        );
        if (response.ok) {
          const data = (await response.json()) as { messages: SignalMessage[] };
          for (const message of data.messages) {
            try {
              await handleSignal(message);
            } catch (error) {
              console.error('Failed to handle signal', message.type, error);
            }
          }
        } else {
          console.error('Signaling poll failed', response.status);
        }
      } catch (error) {
        console.error('Signaling poll error', error);
      }

      if (!stoppedRef.current) {
        pollTimerRef.current = setTimeout(pollSignals, POLL_INTERVAL_MS);
      }
    }

    async function start() {
      try {
        setStatus('Finding an opponent…');
        const joinResponse = await fetch('/api/signaling', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'join',
            username,
            excludeRoomId: excludeRoomIdRef.current,
          }),
        });
        // Only skip that room for this one join; clear it afterwards.
        excludeRoomIdRef.current = null;

        if (!joinResponse.ok) {
          setStatus(`Could not join (server said ${joinResponse.status}).`);
          return;
        }

        const joinData = (await joinResponse.json()) as {
          roomId: string;
          participantId: string;
          waiting: boolean;
        };
        roomIdRef.current = joinData.roomId;
        participantIdRef.current = joinData.participantId;

        setStatus('Requesting camera and microphone…');
        // On Windows a single physical webcam is often locked by the first tab,
        // so a second tab's getUserMedia({video}) throws. Degrade gracefully so
        // two tabs on one machine (one real camera, one viewer) still connect.
        const stream = await getLocalStream(setStatus);
        localStreamRef.current = stream;
        if (stream && localVideoRef.current) localVideoRef.current.srcObject = stream;

        const iceServers = await fetchIceServers();
        const peerConnection = new RTCPeerConnection({ iceServers });
        peerConnectionRef.current = peerConnection;

        const haveVideo = (stream?.getVideoTracks().length ?? 0) > 0;
        const haveAudio = (stream?.getAudioTracks().length ?? 0) > 0;
        if (stream) stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));
        // Receive-only transceivers for kinds this tab can't send, so a
        // camera-less viewer still negotiates to receive the other player.
        if (!haveVideo) peerConnection.addTransceiver('video', { direction: 'recvonly' });
        if (!haveAudio) peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        peerConnection.ontrack = (event) => {
          setConnected(true);
          setStatus('Connected.');
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            void sendSignal({ type: 'candidate', payload: event.candidate.toJSON() });
          }
        };

        peerConnection.oniceconnectionstatechange = () => {
          const state = peerConnection.iceConnectionState;
          if (state === 'checking') {
            setStatus('Connecting to opponent…');
          } else if (state === 'connected' || state === 'completed') {
            setConnected(true);
            setStatus('Connected.');
          } else if (state === 'failed') {
            setConnected(false);
            setStatus(
              'Connection failed — no network path to the opponent (needs a TURN server across different networks).',
            );
          } else if (state === 'disconnected') {
            setStatus('Connection lost, retrying…');
          }
        };

        setStatus(
          joinData.waiting ? 'Waiting for an opponent to join…' : 'Opponent is already here. Connecting…',
        );

        void pollSignals();
      } catch (error) {
        console.error('Failed to start call', error);
        setStatus(
          `Could not start the call: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    void start();

    return () => {
      stoppedRef.current = true;
      window.removeEventListener('pagehide', sendByeBeacon);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      void sendSignal({ type: 'bye' });
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [username, sessionId]);

  function joinCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUsername(usernameInput.trim().slice(0, 32));
  }

  // Leave the current opponent and immediately look for a different one. The
  // room being left is excluded from the next match so you don't get rematched
  // with the same person.
  function nextPlayer() {
    excludeRoomIdRef.current = roomIdRef.current;
    setStatus('Finding a new opponent…');
    setSessionId((value) => value + 1);
  }

  // End the call and go back to the name-entry menu (effect cleanup sends bye).
  function endCall() {
    excludeRoomIdRef.current = null;
    setStatus('');
    setUsername('');
  }

  return (
    <main className="relative min-h-screen bg-[#07060a] text-white font-mono">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6">
        <header className="mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="text-sm font-bold uppercase tracking-widest text-white/60 transition hover:text-lime-400"
          >
            ‹ Menu
          </Link>
          <h1 className="text-lg font-black uppercase tracking-[0.3em]">
            JESTER<span className="text-lime-400">MAXX</span> ARENA
          </h1>
          <span className="w-16" />
        </header>

        {!username ? (
          <section className="flex flex-1 flex-col items-center justify-center">
            <form
              onSubmit={joinCall}
              className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-8"
            >
              <label htmlFor="username" className="text-xs font-bold uppercase tracking-widest text-white/60">
                Your name
              </label>
              <input
                id="username"
                name="username"
                value={usernameInput}
                onChange={(event) => setUsernameInput(event.target.value)}
                maxLength={32}
                required
                autoComplete="nickname"
                placeholder="e.g. jester42"
                className="rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-lime-400"
              />
              <button
                type="submit"
                className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300"
              >
                Enter the Arena
              </button>
            </form>
          </section>
        ) : (
          <section className="flex flex-1 flex-col">
            <p
              role="status"
              className="mb-4 flex items-center justify-center gap-2 text-center text-sm text-white/70"
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-lime-400' : 'animate-pulse bg-amber-400'}`}
              />
              {status}
            </p>

            {/* Side-by-side video tiles (stack on small screens) */}
            <div className="grid flex-1 gap-4 md:grid-cols-2">
              <VideoTile label="You" mirrored muted videoRef={localVideoRef} />
              <VideoTile label="Opponent" videoRef={remoteVideoRef} placeholder={!connected} />
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={nextPlayer}
                className="rounded-xl bg-fuchsia-500 px-6 py-3 text-sm font-black uppercase tracking-widest text-white transition hover:bg-fuchsia-400"
              >
                Next player ›
              </button>
              <button
                onClick={endCall}
                className="rounded-xl border border-white/20 bg-white/5 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white/80 transition hover:border-red-500/60 hover:text-red-400"
              >
                End call
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function VideoTile({
  label,
  videoRef,
  mirrored = false,
  muted = false,
  placeholder = false,
}: {
  label: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored?: boolean;
  muted?: boolean;
  placeholder?: boolean;
}) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="h-full w-full object-cover"
        style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
      />
      {placeholder && (
        <div className="absolute inset-0 flex items-center justify-center text-4xl text-white/20">
          🃏
        </div>
      )}
      <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-white/80">
        {label}
      </span>
    </div>
  );
}
