'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';

type SignalMessage =
  | { type: 'peer-joined' | 'bye' }
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit };

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

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

export default function VideoCall() {
  const [usernameInput, setUsernameInput] = useState('');
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('');
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    if (!username) return;

    stoppedRef.current = false;
    pendingCandidatesRef.current = [];

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
      // refreshed, leaving a "ghost" participant that occupies the room for up
      // to 30 seconds. sendBeacon is designed to reliably deliver during unload.
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
        setStatus('Other player joined. Connecting…');
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
        // Polling can deliver messages out of order (especially over a proxied
        // tunnel), so a candidate may arrive before the offer/answer that sets
        // the remote description. Buffer it instead of failing outright, since
        // the signaling server discards fetched messages and never redelivers.
        if (peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(message.payload);
        } else {
          pendingCandidatesRef.current.push(message.payload);
        }
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
              // One malformed/out-of-order message should not drop the rest of
              // the batch, since the server never redelivers fetched messages.
              console.error('Failed to handle signal', message.type, error);
            }
          }
        } else {
          console.error('Signaling poll failed', response.status);
        }
      } catch (error) {
        // Polling is retried automatically, but log so failures are visible
        // in the console instead of silently vanishing.
        console.error('Signaling poll error', error);
      }

      if (!stoppedRef.current) {
        pollTimerRef.current = setTimeout(pollSignals, 500);
      }
    }

    async function start() {
      try {
        setStatus('Joining room…');
        // The server assigns users in pairs: 1+2, then 3+4, then 5+6, etc.
        const joinResponse = await fetch('/api/signaling', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'join', username }),
        });
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;

        const iceServers = await fetchIceServers();
        console.log(
          'Using ICE servers:',
          iceServers.map((server) => server.urls),
        );
        const peerConnection = new RTCPeerConnection({ iceServers });
        peerConnectionRef.current = peerConnection;
        stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

        peerConnection.ontrack = (event) => {
          setStatus('Connected.');
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            console.log('Local candidate:', event.candidate.type, event.candidate.protocol, event.candidate.address);
            void sendSignal({ type: 'candidate', payload: event.candidate.toJSON() });
          }
        };

        peerConnection.onicecandidateerror = (event) => {
          const candidateError = event as RTCPeerConnectionIceErrorEvent;
          console.error(
            'ICE candidate error:',
            candidateError.errorCode,
            candidateError.errorText,
            candidateError.url,
          );
        };

        peerConnection.oniceconnectionstatechange = () => {
          console.log('ICE connection state:', peerConnection.iceConnectionState);
          if (peerConnection.iceConnectionState === 'checking') {
            setStatus('Connecting to other player…');
          } else if (
            peerConnection.iceConnectionState === 'connected' ||
            peerConnection.iceConnectionState === 'completed'
          ) {
            setStatus('Connected.');
          } else if (peerConnection.iceConnectionState === 'failed') {
            setStatus(
              'Connection failed: could not find a network path to the other player (likely needs a TURN server).',
            );
          } else if (peerConnection.iceConnectionState === 'disconnected') {
            setStatus('Connection lost, retrying…');
          }
        };

        setStatus(
          joinData.waiting ? 'Waiting for the other player to join…' : 'Other player is already here. Connecting…',
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
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [username]);

  function joinCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUsername(usernameInput.trim().slice(0, 32));
  }

  return (
    <section aria-label="Jester Maxing video call">
      <h1>Jester Maxing</h1>
      {!username ? (
        <form onSubmit={joinCall}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            value={usernameInput}
            onChange={(event) => setUsernameInput(event.target.value)}
            maxLength={32}
            required
            autoComplete="nickname"
          />
          <button type="submit">Join call</button>
        </form>
      ) : (
        <div>
          <p role="status">{status}</p>
          <video ref={localVideoRef} autoPlay muted playsInline />
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      )}
    </section>
  );
}
