'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLaughDetector } from '../lib/laugh/use-laugh-detector';
import type { ExpressionLabel, LaughEvent, ScoreReason } from '../lib/laugh/types';

// Live expression readout shown on the local tile — coarse, honest labels only.
const EXPRESSION_BADGE: Record<ExpressionLabel, string> = {
  'no-face': '👁 no face',
  neutral: '😐 neutral',
  smiling: '🙂 smiling',
  'possible-laughter': '😂 laughing?',
};

// Short toast text for a scoring event, shown briefly beside the counter.
function reasonLabel(reason: ScoreReason, points: number): string {
  if (reason === 'smile') return `🙂 smile +${points}`;
  if (reason === 'face-timeout') return `🙈 no-show +${points}`;
  if (reason === 'mouth-cover') return `✋ mouth cover +${points}`;
  return `😂 +${points}`;
}

// Scores can be fractional (a smile is 0.5). Show whole numbers cleanly.
function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Each match lasts this long once both players are connected.
const MATCH_DURATION_MS = 120_000;

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
import IntroPlayback from './intro-playback';
import { fetchIntro, loadCachedIntro, saveCachedIntro } from '../lib/intro-cache';
import { loadSavedUsername, saveUsername } from '../lib/username';
import type { IntroRecordResolved } from '../../lib/intro-templates';

type SignalMessage =
  | { type: 'peer-joined'; payload: { username: string } }
  | { type: 'bye' }
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit }
  | { type: 'laugh'; payload: LaughEvent }
  | { type: 'relay-upgrade' };

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// How often the client polls for signaling messages. Lower = faster handshake
// (and faster ghost cleanup, since each poll refreshes lastSeen) at the cost of
// more requests. 400ms keeps connection setup snappy without hammering.
const POLL_INTERVAL_MS = 400;

// First attempt connects with STUN only (no TURN in the config at all), so no
// relay allocation happens unless it's actually needed — host candidates
// still cover both IPv4 and IPv6 automatically (the browser gathers every
// address family the OS routes to; nothing extra is needed for that). If ICE
// hasn't connected by this deadline, both sides add the TURN pool and the
// caller drives an ICE restart. DCUtR-style: direct first, relay as fallback.
const DIRECT_ATTEMPT_TIMEOUT_MS = 4000;

function isStunOnly(entry: RTCIceServer): boolean {
  const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
  return urls.every((url) => url.startsWith('stun:') || url.startsWith('stuns:'));
}

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

// Moderate video keeps bandwidth (and TURN relay cost) low: 640x480@24 is far
// cheaper than the browser's 720p/1080p default and also lighter/smoother. Audio
// gets the standard voice cleanups.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// Cap the video encoder's bitrate so a relayed (TURN) call can't balloon. ~450
// kbps is plenty for 640x480 talking-head video.
const MAX_VIDEO_BITRATE = 450_000;

// Try progressively weaker media constraints so a locked/absent camera does not
// abort the call. Returns null when no device is usable (view-only participant).
async function getLocalStream(
  setStatus: (message: string) => void,
): Promise<MediaStream | null> {
  const attempts: MediaStreamConstraints[] = [
    { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS },
    { video: VIDEO_CONSTRAINTS, audio: false },
    { video: false, audio: AUDIO_CONSTRAINTS },
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
  const router = useRouter();
  const [usernameInput, setUsernameInput] = useState('');
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('');
  // The opponent's intro reel, played in the opponent tile in place of a
  // loading screen until the real remote video connects. Never our own.
  const [opponentIntroRecord, setOpponentIntroRecord] = useState<IntroRecordResolved | null>(null);
  // Whether that reel has played all the way through at least once. The
  // switch to real video waits on this too, so a fast connection never cuts
  // the intro off mid-loop.
  const [introHasPlayed, setIntroHasPlayed] = useState(false);
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
  const [youToast, setYouToast] = useState<string | null>(null);
  const [oppToast, setOppToast] = useState<string | null>(null);
  // Match timer + result. `matchResult` null = match in progress or not started.
  const [timeLeft, setTimeLeft] = useState(MATCH_DURATION_MS / 1000);
  const [matchResult, setMatchResult] = useState<'win' | 'lose' | null>(null);
  // Latest scores, mirrored to a ref so the timer callback reads fresh values.
  const scoresRef = useRef({ you: 0, opp: 0 });
  const matchEndedRef = useRef(false);

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
  // Full ICE server pool (incl. TURN), fetched once per call; held back from
  // the initial RTCPeerConnection config until/unless the relay fallback fires.
  const fullIceServersRef = useRef<RTCIceServer[]>([]);
  // Only the offerer drives an ICE restart — the callee just upgrades its own
  // config in response to the 'relay-upgrade' signal.
  const isCallerRef = useRef(false);
  const relayFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayAppliedRef = useRef(false);
  // The room a "Next player" click is leaving, so the server won't rematch it.
  const excludeRoomIdRef = useRef<string | null>(null);
  // Bridges the laugh detector (component scope) to sendSignal (effect scope).
  const sendLaughRef = useRef<((event: LaughEvent) => void) | null>(null);
  const oppFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oppToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Called when YOUR scoring event fires (laugh, smile bonus, or face-timeout):
  // count it against you, flash a toast, and tell the opponent so their score
  // goes up. Only this compact event is sent — never audio or features.
  const handleLocalLaugh = useCallback((event: LaughEvent) => {
    setYouLaughed((value) => value + event.points);
    setYouToast(reasonLabel(event.reason, event.points));
    if (youToastTimerRef.current) clearTimeout(youToastTimerRef.current);
    youToastTimerRef.current = setTimeout(() => setYouToast(null), 1600);
    sendLaughRef.current?.(event);
  }, []);

  const { status: laughStatus, recentLaugh, faceAvailable, expression } = useLaughDetector({
    stream: localStream,
    videoRef: localVideoRef,
    overlayRef: faceOverlayRef,
    // Only detect/score while actually matched and connected to an opponent.
    enabled: connected,
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

  // Keep a fresh copy of the scores for the timer callback to read.
  useEffect(() => {
    scoresRef.current = { you: youLaughed, opp: oppLaughed };
  }, [youLaughed, oppLaughed]);

  // 2-minute match timer. Starts when connected to an opponent. At zero: higher
  // score wins (win/lose screen + call ends); a tie auto-finds the next player.
  useEffect(() => {
    if (!connected) return;
    matchEndedRef.current = false;
    const deadline = Date.now() + MATCH_DURATION_MS;
    const id = setInterval(() => {
      const remainMs = Math.max(0, deadline - Date.now());
      setTimeLeft(Math.ceil(remainMs / 1000));
      if (remainMs > 0 || matchEndedRef.current) return;
      matchEndedRef.current = true;
      const { you, opp } = scoresRef.current; // opp = your points, you = theirs
      if (opp === you) {
        // Tie -> automatically queue the next opponent (same as "Next player").
        excludeRoomIdRef.current = roomIdRef.current;
        setStatus('Draw — finding a new opponent…');
        setSessionId((value) => value + 1);
      } else {
        setConnected(false); // freeze the match + stop detection
        setMatchResult(opp > you ? 'win' : 'lose');
      }
    }, 250);
    return () => clearInterval(id);
  }, [connected]);

  useEffect(() => {
    if (!username) return;

    stoppedRef.current = false;
    pendingCandidatesRef.current = [];
    isCallerRef.current = false;
    relayAppliedRef.current = false;
    if (relayFallbackTimerRef.current) {
      clearTimeout(relayFallbackTimerRef.current);
      relayFallbackTimerRef.current = null;
    }
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

    // Looks up the opponent's saved intro reel (cache first) as soon as we
    // know who they are, so their reel — not our own — plays while we wait.
    async function loadOpponentIntro(opponentUsername: string) {
      const cached = loadCachedIntro(opponentUsername);
      const intro = cached ?? (await fetchIntro(opponentUsername));
      if (intro) setOpponentIntroRecord(intro);
    }

    async function createOffer() {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      isCallerRef.current = true;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      scheduleRelayFallback();
      await sendSignal({ type: 'offer', payload: offer });
    }

    // Upgrades this peer's own config to include TURN, and — only if we're the
    // one who made the original offer — drives an ICE restart so both sides
    // renegotiate with relay candidates in play. The 'relay-upgrade' signal is
    // sent (and awaited) before the restart offer, and the signaling queue is
    // FIFO per participant, so the callee always applies the same config
    // upgrade before it ever sees the restart offer — no race between the two.
    async function applyRelayFallback() {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection || relayAppliedRef.current) return;
      relayAppliedRef.current = true;
      if (relayFallbackTimerRef.current) {
        clearTimeout(relayFallbackTimerRef.current);
        relayFallbackTimerRef.current = null;
      }

      setStatus('Direct connection is slow — falling back to relay…');
      peerConnection.setConfiguration({ iceServers: fullIceServersRef.current });

      if (isCallerRef.current) {
        await sendSignal({ type: 'relay-upgrade' });
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        await sendSignal({ type: 'offer', payload: offer });
      }
    }

    function scheduleRelayFallback() {
      if (relayFallbackTimerRef.current || relayAppliedRef.current) return;
      relayFallbackTimerRef.current = setTimeout(() => {
        relayFallbackTimerRef.current = null;
        const peerConnection = peerConnectionRef.current;
        if (!peerConnection || relayAppliedRef.current) return;
        const state = peerConnection.iceConnectionState;
        if (state === 'connected' || state === 'completed') return; // direct path worked
        void applyRelayFallback();
      }, DIRECT_ATTEMPT_TIMEOUT_MS);
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
        void loadOpponentIntro(message.payload.username);
        await createOffer();
      } else if (message.type === 'offer') {
        await peerConnection.setRemoteDescription(message.payload);
        await flushPendingCandidates();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        scheduleRelayFallback();
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
      } else if (message.type === 'relay-upgrade') {
        // The caller decided direct isn't working — upgrade our own config
        // now, ahead of the restart offer that's guaranteed to follow it.
        if (!relayAppliedRef.current) {
          relayAppliedRef.current = true;
          if (relayFallbackTimerRef.current) {
            clearTimeout(relayFallbackTimerRef.current);
            relayFallbackTimerRef.current = null;
          }
          setStatus('Direct connection is slow — falling back to relay…');
          peerConnection.setConfiguration({ iceServers: fullIceServersRef.current });
        }
      } else if (message.type === 'bye') {
        // Opponent left the call. Clear their video/intro and prompt for a new one.
        setConnected(false);
        setOpponentIntroRecord(null);
        setIntroHasPlayed(false);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        setStatus('Opponent left. Tap “Next player” to find someone new.');
      } else if (message.type === 'laugh') {
        // The opponent's browser scored an event -> you gain the points.
        const scored = message.payload;
        setOppLaughed((value) => value + scored.points);
        setOppToast(reasonLabel(scored.reason, scored.points));
        if (oppToastTimerRef.current) clearTimeout(oppToastTimerRef.current);
        oppToastTimerRef.current = setTimeout(() => setOppToast(null), 1600);
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
      setYouToast(null);
      setOppToast(null);
      setMatchResult(null);
      setTimeLeft(MATCH_DURATION_MS / 1000);
      setOpponentIntroRecord(null);
      setIntroHasPlayed(false);
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
          opponentUsername?: string;
        };
        roomIdRef.current = joinData.roomId;
        participantIdRef.current = joinData.participantId;
        if (joinData.opponentUsername) void loadOpponentIntro(joinData.opponentUsername);

        setStatus('Requesting camera and microphone…');
        // On Windows a single physical webcam is often locked by the first tab,
        // so a second tab's getUserMedia({video}) throws. Degrade gracefully so
        // two tabs on one machine (one real camera, one viewer) still connect.
        const stream = await getLocalStream(setStatus);
        localStreamRef.current = stream;
        setLocalStream(stream); // hand the audio track to the laugh detector
        if (stream && localVideoRef.current) localVideoRef.current.srcObject = stream;

        const iceServers = await fetchIceServers();
        fullIceServersRef.current = iceServers;
        // Direct-first: gather with STUN only (IPv4 and IPv6 host/srflx
        // candidates both come along automatically, no TURN allocated yet).
        const directOnlyServers = iceServers.filter(isStunOnly);
        const peerConnection = new RTCPeerConnection({
          iceServers: directOnlyServers.length ? directOnlyServers : iceServers,
        });
        peerConnectionRef.current = peerConnection;

        const haveVideo = (stream?.getVideoTracks().length ?? 0) > 0;
        const haveAudio = (stream?.getAudioTracks().length ?? 0) > 0;
        if (stream) stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));
        // Receive-only transceivers for kinds this tab can't send, so a
        // camera-less viewer still negotiates to receive the other player.
        if (!haveVideo) peerConnection.addTransceiver('video', { direction: 'recvonly' });
        if (!haveAudio) peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        // Cap the outgoing video bitrate so a TURN-relayed call stays cheap.
        if (haveVideo) {
          const videoSender = peerConnection
            .getSenders()
            .find((sender) => sender.track?.kind === 'video');
          if (videoSender) {
            const params = videoSender.getParameters();
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
            params.encodings[0].maxFramerate = 30;
            void videoSender.setParameters(params).catch(() => {
              // Non-fatal: some browsers reject mid-negotiation; bitrate stays default.
            });
          }
        }

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
            if (!relayAppliedRef.current) {
              void applyRelayFallback();
            } else {
              setConnected(false);
              setStatus('Connection failed — even the relay could not reach the opponent.');
            }
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
      if (relayFallbackTimerRef.current) clearTimeout(relayFallbackTimerRef.current);
      void sendSignal({ type: 'bye' });
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      sendLaughRef.current = null;
      if (oppFlashTimerRef.current) clearTimeout(oppFlashTimerRef.current);
      if (youToastTimerRef.current) clearTimeout(youToastTimerRef.current);
      if (oppToastTimerRef.current) clearTimeout(oppToastTimerRef.current);
      setLocalStream(null); // stops the laugh detector (its effect re-runs)
    };
  }, [username, sessionId]);

  // An intro reel is mandatory before joining: check the local cache first,
  // then fall back to the server (covers a new device/tab). If none exists
  // yet, send the player to build one and come straight back here after.
  async function joinCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = usernameInput.trim().slice(0, 32);
    if (!name) return;
    saveUsername(name); // remember for next visit until a real DB exists

    // Only gates entry — the fetched record itself is never shown, since we
    // only ever display the opponent's intro reel, never our own.
    const cached = loadCachedIntro(name);
    const intro = cached ?? (await fetchIntro(name));
    if (!intro) {
      router.push(`/intro?username=${encodeURIComponent(name)}&next=/arena`);
      return;
    }
    if (!cached) saveCachedIntro(name, intro);

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
    setMatchResult(null);
    setOpponentIntroRecord(null);
    setIntroHasPlayed(false);
  }

  // From the result screen: clear it and immediately queue a fresh opponent.
  function playAgain() {
    setMatchResult(null);
    nextPlayer();
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
              {connected && (
                <span
                  className={`ml-2 rounded-md bg-white/10 px-2 py-0.5 font-black tabular-nums ${
                    timeLeft <= 10 ? 'text-red-400' : 'text-lime-400'
                  }`}
                >
                  ⏱ {fmtTime(timeLeft)}
                </span>
              )}
            </p>

            {/* Scoreboard: you score by making the opponent laugh; if YOU laugh,
                the point goes to them. */}
            <div className="mx-auto mb-4 flex w-full max-w-md items-stretch gap-3 text-center">
              <div className="relative flex-1 rounded-xl border border-lime-400/30 bg-lime-400/10 px-4 py-3">
                {oppToast && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 animate-pulse whitespace-nowrap rounded-full bg-lime-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-black shadow-lg">
                    {oppToast}
                  </span>
                )}
                <div className="text-2xl font-black text-lime-400">{fmtScore(oppLaughed)}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                  Your points · they cracked
                </div>
              </div>
              <div className="relative flex-1 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
                {youToast && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 animate-pulse whitespace-nowrap rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white shadow-lg">
                    {youToast}
                  </span>
                )}
                <div className="text-2xl font-black text-red-400">{fmtScore(youLaughed)}</div>
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
                    ? EXPRESSION_BADGE[expression]
                    : laughStatus === 'listening'
                      ? '🎤 detecting'
                      : undefined
                }
              />
              <VideoTile
                label="Opponent"
                videoRef={remoteVideoRef}
                placeholder={!connected}
                overlay={
                  (!connected || !introHasPlayed) && opponentIntroRecord ? (
                    <IntroPlayback
                      slides={opponentIntroRecord.slides}
                      transitionId={opponentIntroRecord.transitionId}
                      onCycleComplete={() => setIntroHasPlayed(true)}
                    />
                  ) : undefined
                }
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

      {matchResult && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-8 bg-[#07060a]/95 px-6 text-center backdrop-blur">
          <div>
            <div
              className="text-6xl font-black uppercase tracking-tight sm:text-8xl"
              style={{
                color: matchResult === 'win' ? '#a3e635' : '#f87171',
                textShadow:
                  matchResult === 'win'
                    ? '0 0 30px rgba(163,230,53,0.6)'
                    : '0 0 30px rgba(248,113,113,0.5)',
              }}
            >
              {matchResult === 'win' ? 'You Win' : 'You Lose'}
            </div>
            <p className="mt-4 text-sm uppercase tracking-[0.3em] text-white/60">
              You {fmtScore(oppLaughed)} · Them {fmtScore(youLaughed)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={playAgain}
              className="rounded-xl bg-lime-400 px-8 py-3.5 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300"
            >
              Play again
            </button>
            <button
              onClick={endCall}
              className="rounded-xl border border-white/20 bg-white/5 px-8 py-3.5 text-sm font-bold uppercase tracking-widest text-white/80 transition hover:border-white/40 hover:text-white"
            >
              Back to menu
            </button>
          </div>
        </div>
      )}
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
  overlay,
  flashing = false,
  badge,
}: {
  label: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef?: React.RefObject<HTMLCanvasElement | null>;
  mirrored?: boolean;
  muted?: boolean;
  placeholder?: boolean;
  overlay?: React.ReactNode;
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
      {overlay ? (
        <div className="absolute inset-0">{overlay}</div>
      ) : (
        placeholder && (
          <div className="absolute inset-0 flex items-center justify-center text-4xl text-white/20">
            🃏
          </div>
        )
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
