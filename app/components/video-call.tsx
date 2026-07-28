'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLaughDetector } from '../lib/laugh/use-laugh-detector';
import type { LaughEvent } from '../lib/laugh/types';

type SignalMessage =
  | { type: 'peer-joined' | 'bye' }
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit }
  | { type: 'laugh'; payload: LaughEvent };

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// Persist the chosen name in the browser until a real user/DB exists, so it
// prefills on the next visit. Client-only, no account, no server.
const USERNAME_STORAGE_KEY = 'jestermaxx:username';

function loadSavedUsername(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(USERNAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveUsername(name: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USERNAME_STORAGE_KEY, name);
  } catch {
    // Storage can be unavailable (private mode / blocked) — non-fatal.
  }
}

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
  // Laugh scoring. `oppLaughed` = times the opponent laughed = YOUR score (you
  // made them laugh). `youLaughed` = times you laughed. The local stream is kept
  // in state so the laugh detector hook can attach to its audio track.
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [youLaughed, setYouLaughed] = useState(0);
  const [oppLaughed, setOppLaughed] = useState(0);
  const [oppFlash, setOppFlash] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const faceOverlayRef = useRef<HTMLCanvasElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  // The room a "Next player" click is leaving, so the server won't rematch it.
  const excludeRoomIdRef = useRef<string | null>(null);
  // Bridges the laugh detector (component scope) to sendSignal (effect scope).
  const sendLaughRef = useRef<((event: LaughEvent) => void) | null>(null);
  const oppFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Called when YOUR laugh is confirmed: count it and tell the opponent so their
  // score goes up. Only this compact event is sent — never audio or features.
  const handleLocalLaugh = useCallback((event: LaughEvent) => {
    setYouLaughed((value) => value + 1);
    sendLaughRef.current?.(event);
  }, []);

  const { status: laughStatus, recentLaugh, faceAvailable } = useLaughDetector({
    stream: localStream,
    videoRef: localVideoRef,
    overlayRef: faceOverlayRef,
    enabled: Boolean(username),
    onLaugh: handleLocalLaugh,
  });

  // Prefill the previously saved name on first load (deferred so it isn't a
  // synchronous setState in the effect body, and avoids a hydration mismatch).
  useEffect(() => {
    const saved = loadSavedUsername();
    if (!saved) return;
    const timer = setTimeout(() => setUsernameInput(saved), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!username) return;

    stoppedRef.current = false;
    pendingCandidatesRef.current = [];
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

    // Expose a laugh sender to the detector callback living in component scope.
    sendLaughRef.current = (event: LaughEvent) => void sendSignal({ type: 'laugh', payload: event });

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
      } else if (message.type === 'laugh') {
        // The opponent's browser confirmed a laugh -> you scored. Flash their tile.
        setOppLaughed((value) => value + 1);
        setOppFlash(true);
        if (oppFlashTimerRef.current) clearTimeout(oppFlashTimerRef.current);
        oppFlashTimerRef.current = setTimeout(() => setOppFlash(false), 1200);
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
      setConnected(false);
      setYouLaughed(0);
      setOppLaughed(0);
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
        setLocalStream(stream); // hand the audio track to the laugh detector
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
      sendLaughRef.current = null;
      if (oppFlashTimerRef.current) clearTimeout(oppFlashTimerRef.current);
      setLocalStream(null); // stops the laugh detector (its effect re-runs)
    };
  }, [username, sessionId]);

  function joinCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = usernameInput.trim().slice(0, 32);
    saveUsername(name); // remember for next visit until a real DB exists
    setUsername(name);
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

            {/* Scoreboard: you score by making the opponent laugh; if YOU laugh,
                the point goes to them. */}
            <div className="mx-auto mb-4 flex w-full max-w-md items-stretch gap-3 text-center">
              <div className="flex-1 rounded-xl border border-lime-400/30 bg-lime-400/10 px-4 py-3">
                <div className="text-2xl font-black text-lime-400">{oppLaughed}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                  Your points · they laughed
                </div>
              </div>
              <div className="flex-1 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-3">
                <div className="text-2xl font-black text-fuchsia-400">{youLaughed}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                  You cracked · point to them
                </div>
              </div>
            </div>

            {/* Side-by-side video tiles (stack on small screens) */}
            <div className="grid flex-1 gap-4 md:grid-cols-2">
              <VideoTile
                label="You"
                mirrored
                muted
                videoRef={localVideoRef}
                overlayRef={faceOverlayRef}
                flashing={recentLaugh}
                badge={
                  faceAvailable
                    ? '👁 tracking'
                    : laughStatus === 'listening'
                      ? '🎤 detecting'
                      : undefined
                }
              />
              <VideoTile
                label="Opponent"
                videoRef={remoteVideoRef}
                placeholder={!connected}
                flashing={oppFlash}
                badge={oppFlash ? '😂 laughed!' : undefined}
              />
            </div>

            <p className="mt-3 text-center text-[11px] text-white/30">
              🔒 Audio is analyzed on your device to detect laughs — never recorded or uploaded.
            </p>

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
  overlayRef,
  mirrored = false,
  muted = false,
  placeholder = false,
  flashing = false,
  badge,
}: {
  label: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef?: React.RefObject<HTMLCanvasElement | null>;
  mirrored?: boolean;
  muted?: boolean;
  placeholder?: boolean;
  flashing?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-2xl border bg-black transition-colors duration-200 ${
        flashing ? 'border-lime-400 shadow-[0_0_30px_rgba(163,230,53,0.5)]' : 'border-white/10'
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="h-full w-full object-cover"
        style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
      />
      {overlayRef && (
        <canvas
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
        />
      )}
      {placeholder && (
        <div className="absolute inset-0 flex items-center justify-center text-4xl text-white/20">
          🃏
        </div>
      )}
      <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-white/80">
        {label}
      </span>
      {badge && (
        <span className="absolute right-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-lime-400">
          {badge}
        </span>
      )}
    </div>
  );
}
