'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';

type SignalMessage =
  | { type: 'peer-joined' | 'bye' }
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit };

const ICE_SERVERS: RTCConfiguration = {
  // STUN lets WebRTC discover each user's public network address. A TURN
  // server should be added later for networks that block direct peer traffic.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function VideoCall() {
  const [usernameInput, setUsernameInput] = useState('');
  const [username, setUsername] = useState('');
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!username) return;

    stoppedRef.current = false;

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

    async function createOffer() {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await sendSignal({ type: 'offer', payload: offer });
    }

    async function handleSignal(message: SignalMessage) {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) return;

      if (message.type === 'peer-joined') {
        // The first person in every room is the caller. When the second person
        // joins, only that first person receives this event and creates offer.
        await createOffer();
      } else if (message.type === 'offer') {
        await peerConnection.setRemoteDescription(message.payload);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await sendSignal({ type: 'answer', payload: answer });
      } else if (message.type === 'answer') {
        await peerConnection.setRemoteDescription(message.payload);
      } else if (message.type === 'candidate') {
        await peerConnection.addIceCandidate(message.payload);
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
            await handleSignal(message);
          }
        }
      } catch {
        // Polling is retried automatically. Keeping this silent preserves the
        // requested minimal screen instead of showing a text status panel.
      }

      if (!stoppedRef.current) {
        pollTimerRef.current = setTimeout(pollSignals, 500);
      }
    }

    async function start() {
      try {
        // Room allocation is done on the server. It always puts visitor 1 and
        // 2 together, visitor 3 and 4 together, visitor 5 and 6 together, etc.
        const joinResponse = await fetch('/api/signaling', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'join', username }),
        });
        if (!joinResponse.ok) return;

        const joinData = (await joinResponse.json()) as {
          roomId: string;
          participantId: string;
        };
        roomIdRef.current = joinData.roomId;
        participantIdRef.current = joinData.participantId;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;

        const peerConnection = new RTCPeerConnection(ICE_SERVERS);
        peerConnectionRef.current = peerConnection;
        stream.getTracks().forEach((track) => {
          peerConnection.addTrack(track, stream);
        });

        peerConnection.ontrack = (event) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        };

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            void sendSignal({
              type: 'candidate',
              payload: event.candidate.toJSON(),
            });
          }
        };

        void pollSignals();
      } catch {
        // Camera/microphone permission and connection failures are intentionally
        // not rendered as chat text because this screen is meant to stay bare.
      }
    }

    void start();

    return () => {
      stoppedRef.current = true;
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
          <video ref={localVideoRef} autoPlay muted playsInline />
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      )}
    </section>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <VideoCall />
        {children}
      </body>
    </html>
  );
}
