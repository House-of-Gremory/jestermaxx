# JesterMaxx Laugh Detection — Implementation Specification

## 1. Product goal

JesterMaxx is a live 1v1 video competition. The browser should detect a laugh
without uploading the participant's camera feed, microphone recording, face
landmarks, or raw audio. When a laugh is confidently detected, the match should
record a lightweight event. At the end of the match, the application stores
only the result:

- who won;
- who lost;
- each participant's score;
- the match metadata required to display history and prevent duplicate results.

Detection is a local assistive signal, not a medical, legal, identity, or
emotion-recognition system. The UI must avoid claiming that the model can know
with certainty that a person laughed.

## 2. Non-negotiable architecture

```text
Camera ──► MediaPipe Face Landmarker ──► face features ─┐
                                                        ├─► client classifier
Microphone ─► Web Audio API ──► audio features ─────────┘       │
                                                               ▼
                                                     laugh state machine
                                                               │
                                      laugh event only (no media/features)
                                                               │
                                                               ▼
                                                match result API / database
```

The entire detection pipeline runs in the browser. The server never receives
camera frames, microphone samples, face landmarks, blendshape values, or audio
feature vectors.

The server receives only validated match events and the final match result.
The server remains authoritative for scores and winner/loser state because a
browser cannot safely be trusted to award itself points.

## 3. Client-side technology

| Responsibility | Recommended implementation |
|---|---|
| Face tracking | MediaPipe Face Landmarker through `@mediapipe/tasks-vision` |
| Camera frames | Existing `<video>` element plus `requestVideoFrameCallback` where available |
| Microphone capture | `navigator.mediaDevices.getUserMedia({ audio: true })` |
| Audio processing | Web Audio API `AudioContext` and `AnalyserNode` |
| Audio features | RMS, zero-crossing rate, spectral centroid, band energy, pitch variation |
| Optional VAD | WebRTC VAD or a small local energy/VAD implementation |
| Optional classifier | TensorFlow.js model trained on engineered face/audio features |
| Transport | Existing REST API; send compact laugh/result events only |

The first version should use deterministic feature extraction and a state
machine. A trained classifier can be added later behind the same interface:

```ts
type LaughDecision = {
  isLaughing: boolean;
  confidence: number;
  startedAt?: number;
  endedAt?: number;
  signals: Array<'face' | 'audio' | 'rhythm'>;
};
```

## 4. Permissions and initialization

Request camera and microphone permission only after the participant explicitly
enters the arena. Explain the purpose before requesting access:

> Your camera and microphone are processed locally to detect laugh events. We
> do not record or upload your video or audio.

Initialization must:

1. Start the existing WebRTC call.
2. Reuse the local camera stream for face analysis.
3. Create a separate audio analysis path from the local audio track.
4. Keep the `MediaStreamAudioSourceNode` connected only to the analyser; do not
   connect it to `AudioContext.destination`, which would echo the microphone.
5. Start detection only after the video has dimensions and the audio context is
   running.
6. Stop all detectors, animation frames, audio nodes, and model resources when
   the participant leaves or the match ends.

If camera or microphone permission is denied, the call can continue, but laugh
scoring must be disabled or marked unavailable. Never infer a laugh from a
missing device.

## 5. Face feature extraction

Run Face Landmarker locally at approximately 15–30 FPS. Do not process every
camera frame if the device cannot sustain that rate. The detector should use
one face only: the local participant's face. A missing, ambiguous, or heavily
occluded face produces an unavailable face signal rather than a negative laugh.

Normalize blendshape values to `[0, 1]` and smooth them with an exponential
moving average. Keep both the smoothed value and the short-term change rate.

Required features:

```text
mouthSmileLeft
mouthSmileRight
jawOpen
mouthOpen
cheekSquintLeft
cheekSquintRight
```

Derived features:

```text
smile = average(mouthSmileLeft, mouthSmileRight)
eyeSquint = average(cheekSquintLeft, cheekSquintRight)
mouthActivity = abs(delta(jawOpen)) + abs(delta(mouthOpen))
headMotion = normalized short-window change in head yaw/pitch/roll
faceQuality = visibility, detection confidence, and landmark stability
```

Do not use a single smile threshold as a laugh detector. Smiling silently is a
valid non-laugh example.

## 6. Audio feature extraction

Analyze short windows, approximately 20–40 ms, and aggregate them into 250 ms
and 1 second windows. Do not store the raw samples after the current analysis
window has been processed.

Recommended features:

```text
rms                 overall loudness / energy
voiceActivity       whether speech-like sound is present
zeroCrossingRate    noisiness and consonant-like activity
spectralCentroid    brightness of the sound
highBandEnergy      energy above the voice fundamental range
pitch               estimated fundamental frequency when available
pitchDelta          short-term pitch movement
energyDelta         short-term energy movement
```

Audio is not required to be speech. Laughter can be breathy, voiced, noisy, or
partially unvoiced. Therefore, VAD should be a supporting feature rather than a
hard requirement.

Calibrate the noise floor for roughly 500–1000 ms after the microphone starts.
Use relative thresholds based on that floor instead of assuming a fixed device
volume. Recalibrate gradually when the participant is quiet.

## 7. Laugh confirmation logic

The detector should be a temporal state machine, not a one-frame boolean.

### States

```text
QUIET ──► POSSIBLE_LAUGH ──► CONFIRMED_LAUGH ──► COOLDOWN ──► QUIET
  ▲              │                    │
  └──────────────┴────────────────────┘
```

### Candidate signal

Start `POSSIBLE_LAUGH` when a rolling 250 ms window satisfies enough of the
following conditions:

```text
smile >= 0.55
jawOpen or mouthOpen >= 0.25
eyeSquint >= 0.20
audio energy is above calibrated noise floor
audio has short-term energy or pitch variation
```

These values are initial defaults, not universal truths. They must be tuned on
real devices and recorded feature data collected with explicit consent.

### Confirmation signal

Emit one laugh event only when all of these are true:

```text
candidate duration >= 450 ms
candidate duration <= 4 seconds
at least 2 face indicators are active at some point
audio is active during at least 35% of the candidate window
the combined confidence is >= 0.72
```

Suggested initial confidence score:

```text
faceScore =
  0.40 * smileScore +
  0.25 * mouthActivityScore +
  0.20 * eyeSquintScore +
  0.15 * headMotionScore

audioScore =
  0.35 * relativeEnergyScore +
  0.25 * pitchVariationScore +
  0.20 * rhythmScore +
  0.20 * voiceOrNoiseActivityScore

combinedScore = 0.55 * faceScore + 0.45 * audioScore
```

The score must be clamped to `[0, 1]`. If either modality is unavailable, the
detector should expose a lower-confidence mode and require a higher threshold;
the default competitive mode should require both modalities.

### End and cooldown

End a confirmed laugh after 300–500 ms below the continuation threshold. Enter a
cooldown of 1500–2500 ms. Cooldown prevents one long laugh from becoming many
points and gives the participant time to recover.

The client must generate a stable `clientEventId` for every emitted event and
never emit another event for the same confirmed laugh.

## 8. Event semantics and scoring

A laugh event is a gameplay event, not a telemetry stream. Send it once, after
confirmation. Do not send per-frame data or continuously changing confidence.

Recommended client event:

```ts
type LaughEvent = {
  clientEventId: string;
  matchId: string;
  participantId: string;
  occurredAt: number;
  durationMs: number;
  confidence: number;
  detectorVersion: string;
};
```

Do not include:

```text
camera images
audio samples or recordings
face landmarks
blendshape arrays
audio feature arrays
raw usernames supplied by the client as the identity source
```

The server should deduplicate by `(matchId, clientEventId)` and reject events
for unknown participants, finished matches, invalid durations, or confidence
outside `[0, 1]`.

Suggested initial scoring:

```text
confirmed laugh: +1 point
high-confidence laugh (>= 0.90): still +1 point
one laugh during cooldown: +0 points
```

Do not award extra points for confidence in the first release. Confidence is
useful for filtering and diagnostics; multiplying score by confidence makes
the game difficult to understand and encourages detector-specific exploits.

The authoritative result should be calculated on the server:

```ts
type MatchResult = {
  matchId: string;
  winnerParticipantId: string | null;
  loserParticipantId: string | null;
  scores: Record<string, number>;
  laughEventCount: Record<string, number>;
  endedAt: number;
  resultVersion: string;
};
```

If the game has a time limit, the server should reject events received after
the match end and use server time for the final result. A tie should be an
explicit result, not an accidental missing winner.

## 9. REST endpoints

Keep the existing REST approach. GraphQL is not needed for this event stream.

### `POST /api/matches/:matchId/laugh-events`

Request body:

```json
{
  "clientEventId": "evt_01J...",
  "participantId": "person_...",
  "occurredAt": 1730000000000,
  "durationMs": 920,
  "confidence": 0.81,
  "detectorVersion": "face-audio-v1"
}
```

Response:

```json
{
  "accepted": true,
  "eventId": "server-generated-id",
  "score": 4
}
```

The client should queue an event in memory when the request fails and retry it
with exponential backoff. The queue must be bounded and cleared when the match
ends. Never persist microphone or camera data to retry later.

### `POST /api/matches/:matchId/result`

The client may request match completion, but the server must calculate and
persist the result from accepted events. The client-supplied winner, loser, and
score are hints only and must not be trusted.

## 10. Client module boundaries

Suggested modules:

```text
app/lib/laugh/
  types.ts              shared feature and decision types
  face-detector.ts      MediaPipe lifecycle and face feature extraction
  audio-analyzer.ts     Web Audio lifecycle and feature extraction
  laugh-detector.ts     smoothing, fusion, state machine, cooldown
  event-queue.ts        deduplication, retry, and in-memory buffering
  use-laugh-detector.ts React hook used by the arena
```

The React hook should expose only high-level state:

```ts
type LaughDetectorState = {
  status: 'idle' | 'loading' | 'ready' | 'degraded' | 'error' | 'stopped';
  faceAvailable: boolean;
  audioAvailable: boolean;
  confidence: number;
  recentLaugh: boolean;
  laughsDetected: number;
  error?: string;
};
```

Keep MediaPipe, Web Audio, timers, and mutable rolling buffers in refs or plain
classes. Do not put per-frame features in React state; that would cause a
render for every camera/audio tick.

## 11. Performance requirements

- Never block the WebRTC signaling loop with model inference.
- Run inference on a throttled frame loop.
- Reuse typed arrays and audio buffers.
- Dispose the MediaPipe landmarker and close the `AudioContext` on teardown.
- Pause detection when the tab is hidden, then resume after recalibration.
- Show a degraded state when the device cannot maintain the target rate.
- Keep the detector compatible with mobile Safari and browsers without
  `requestVideoFrameCallback` by falling back to `requestAnimationFrame`.

Target budgets on a normal laptop:

```text
face inference: <= 25 ms per processed frame
audio analysis: <= 2 ms per audio window
UI overhead:    <= 5 ms per detector update
memory:         no unbounded buffers or event history
```

## 12. Accuracy and calibration plan

The initial thresholds are a starting point only. Test with consent across:

- different cameras, microphones, browsers, and lighting;
- glasses, facial hair, masks, and partial face visibility;
- quiet speech, loud speech, coughing, sneezing, singing, and shouting;
- smiling without laughing;
- silent laughter and laughter with low microphone volume;
- two people visible in one camera frame;
- background audio and keyboard noise.

Track false positives and false negatives locally during development. Do not
upload raw media. If aggregate diagnostics are needed, send only anonymized
counts such as detector version, accepted/rejected candidate count, and device
capability category, after adding a clear opt-in.

Define success before tuning:

```text
false positive rate during ordinary speech: <= 1 per 10 minutes
duplicate events per laugh: 0
event delivery duplication after retry: 0 server-side
detector startup on supported devices: <= 3 seconds
```

For higher accuracy, collect explicitly consented labeled sessions separately,
extract features locally, and train a small TensorFlow.js classifier. Ship the
model version with the detector and keep the same laugh state machine and event
contract around it. The classifier should improve `combinedScore`; it should
not change the privacy boundary.

## 13. Security and privacy

- Treat every browser event as untrusted input.
- Authenticate or bind `participantId` to the active match session.
- Validate match membership and event timestamps on the server.
- Rate-limit laugh-event requests per participant and match.
- Enforce a maximum event count per minute.
- Deduplicate with a unique database key.
- Do not log request bodies containing event details unnecessarily.
- Do not store raw media, face data, audio data, or biometric identifiers.
- Provide a visible indicator while camera/microphone analysis is active.
- Provide a way to leave the match and immediately stop local analysis.
- Document that detection is probabilistic and may be wrong.

## 14. Implementation phases

### Phase 1 — instrumentation-free local prototype

1. Add the face landmarker and audio analyzer.
2. Render local-only developer diagnostics behind a development flag.
3. Implement smoothing, candidate detection, confirmation, and cooldown.
4. Verify teardown and permission-denied behavior.

### Phase 2 — gameplay events

1. Add `LaughEvent` generation with stable client IDs.
2. Add the in-memory retry queue.
3. Add the REST endpoint and Redis-backed deduplication.
4. Award one server-authoritative point per accepted event.

### Phase 3 — match results

1. Add match lifecycle and server-side end time.
2. Calculate winner, loser, tie, and scores on the server.
3. Persist only the match result and aggregate laugh counts.
4. Make result submission idempotent.

### Phase 4 — accuracy improvements

1. Tune thresholds using consented test sessions.
2. Add a small fused TensorFlow.js classifier if heuristics are insufficient.
3. Version the model and detector separately.
4. Add browser/device capability handling and performance monitoring.

## 15. Definition of done

The implementation is complete when:

- face and audio analysis run entirely in the browser;
- no raw media or feature vectors leave the browser;
- a laugh requires temporal confirmation and cooldown;
- one laugh creates at most one event;
- failed event requests retry without storing media;
- the server deduplicates and validates events;
- the server calculates scores and winner/loser state;
- match completion is idempotent;
- leaving the arena stops all local analysis;
- permission denial produces a clear degraded state;
- `npm run lint` and `npm run build` pass;
- the UI clearly communicates that laugh detection is probabilistic.
