import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as tls from 'node:tls';

// Hand-rolled STUN (RFC 8489) / TURN (RFC 8656) client, just enough to run a
// real TURN Allocate handshake against a server and confirm the credentials
// actually work — not just that the host:port is reachable. No npm STUN/TURN
// library is used; this keeps the dependency list unchanged.

const STUN_MAGIC_COOKIE = 0x2112a442;

const MessageType = {
  BindingRequest: 0x0001,
  BindingSuccess: 0x0101,
  BindingError: 0x0111,
  AllocateRequest: 0x0003,
  AllocateSuccess: 0x0103,
  AllocateError: 0x0113,
} as const;

const AttrType = {
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  Realm: 0x0014,
  Nonce: 0x0015,
  RequestedTransport: 0x0019,
} as const;

export type IceTransport = 'udp' | 'tcp';

export type ParsedIceUrl = {
  scheme: 'turn' | 'turns' | 'stun' | 'stuns';
  host: string;
  port: number;
  transport: IceTransport;
};

// Parses RFC 7064/7065 ICE server URLs: scheme:host[:port][?transport=udp|tcp]
// Supports bracketed IPv6 hosts, e.g. turn:[::1]:3478.
export function parseIceUrl(raw: string): ParsedIceUrl | null {
  const trimmed = raw.trim();
  const schemeMatch = trimmed.match(/^(turns|turn|stuns|stun):(.*)$/i);
  if (!schemeMatch) return null;

  const scheme = schemeMatch[1].toLowerCase() as ParsedIceUrl['scheme'];
  let rest = schemeMatch[2];

  let transportParam: string | null = null;
  const queryIndex = rest.indexOf('?');
  if (queryIndex !== -1) {
    transportParam = new URLSearchParams(rest.slice(queryIndex + 1)).get('transport');
    rest = rest.slice(0, queryIndex);
  }

  let host: string;
  let portStr: string | undefined;
  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx === -1) return null;
    host = rest.slice(1, closeIdx);
    const afterBracket = rest.slice(closeIdx + 1);
    portStr = afterBracket.startsWith(':') ? afterBracket.slice(1) : undefined;
  } else {
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx !== -1) {
      host = rest.slice(0, colonIdx);
      portStr = rest.slice(colonIdx + 1);
    } else {
      host = rest;
    }
  }
  if (!host) return null;

  const isTls = scheme === 'turns' || scheme === 'stuns';
  const port = portStr ? Number(portStr) : isTls ? 5349 : 3478;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const transport: IceTransport = isTls || transportParam?.toLowerCase() === 'tcp' ? 'tcp' : 'udp';

  return { scheme, host, port, transport };
}

function encodeAttr(type: number, value: Buffer): Buffer {
  const paddedLength = Math.ceil(value.length / 4) * 4;
  const buf = Buffer.alloc(4 + paddedLength);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(value.length, 2);
  value.copy(buf, 4);
  return buf;
}

function buildHeader(type: number, bodyLength: number, transactionId: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(bodyLength, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return header;
}

type Credentials = { username: string; realm: string; nonce: string; key: Buffer };

function buildAllocateRequest(transactionId: Buffer, creds?: Credentials): Buffer {
  const attrs: Buffer[] = [];

  // REQUESTED-TRANSPORT: 4 bytes, protocol number (17 = UDP) + 3 reserved bytes.
  // TURN always allocates a UDP relay regardless of the client<->server transport.
  const requestedTransport = Buffer.alloc(4);
  requestedTransport.writeUInt8(17, 0);
  attrs.push(encodeAttr(AttrType.RequestedTransport, requestedTransport));

  if (creds) {
    attrs.push(encodeAttr(AttrType.Username, Buffer.from(creds.username, 'utf8')));
    attrs.push(encodeAttr(AttrType.Realm, Buffer.from(creds.realm, 'utf8')));
    attrs.push(encodeAttr(AttrType.Nonce, Buffer.from(creds.nonce, 'utf8')));
  }

  let body = Buffer.concat(attrs);

  if (creds) {
    // MESSAGE-INTEGRITY = HMAC-SHA1 over the message so far, computed with the
    // header's length field set as if this 24-byte attribute were already
    // appended (RFC 8489 section 14.5).
    const lengthWithIntegrity = body.length + 24;
    const header = buildHeader(MessageType.AllocateRequest, lengthWithIntegrity, transactionId);
    const hmac = createHmac('sha1', creds.key).update(Buffer.concat([header, body])).digest();
    attrs.push(encodeAttr(AttrType.MessageIntegrity, hmac));
    body = Buffer.concat(attrs);
  }

  return Buffer.concat([buildHeader(MessageType.AllocateRequest, body.length, transactionId), body]);
}

function buildBindingRequest(transactionId: Buffer): Buffer {
  return buildHeader(MessageType.BindingRequest, 0, transactionId);
}

type StunAttr = { type: number; value: Buffer };
type StunMessage = { type: number; transactionId: Buffer; attrs: StunAttr[] };

function parseMessage(buf: Buffer): StunMessage | null {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;

  const transactionId = buf.subarray(8, 20);
  const body = buf.subarray(20, 20 + length);
  const attrs: StunAttr[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const attrType = body.readUInt16BE(offset);
    const attrLength = body.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    attrs.push({ type: attrType, value: body.subarray(valueStart, valueStart + attrLength) });
    offset = valueStart + Math.ceil(attrLength / 4) * 4;
  }
  return { type, transactionId, attrs };
}

function findAttr(attrs: StunAttr[], type: number): Buffer | undefined {
  return attrs.find((attr) => attr.type === type)?.value;
}

function parseErrorCode(attrs: StunAttr[]): { code: number; reason: string } | null {
  const value = findAttr(attrs, AttrType.ErrorCode);
  if (!value || value.length < 4) return null;
  const code = (value.readUInt8(2) & 0x7) * 100 + value.readUInt8(3);
  return { code, reason: value.subarray(4).toString('utf8') };
}

function sendUdp(host: string, port: number, message: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out waiting for a UDP response'));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      socket.close();
      fn();
    };

    socket.once('error', (err) => settle(() => reject(err)));
    socket.once('message', (msg) => settle(() => resolve(msg)));
    socket.send(message, port, host, (err) => {
      if (err) settle(() => reject(err));
    });
  });
}

function sendStream(
  host: string,
  port: number,
  useTls: boolean,
  message: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket: net.Socket = useTls
      ? tls.connect({ host, port, timeout: timeoutMs, rejectUnauthorized: false })
      : net.createConnection({ host, port, timeout: timeoutMs });

    let received = Buffer.alloc(0);
    const timer = setTimeout(() => settle(() => reject(new Error('Timed out waiting for a TCP response'))), timeoutMs);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on('error', (err) => settle(() => reject(err)));
    socket.on('timeout', () => settle(() => reject(new Error('Connection timed out'))));
    socket.on(useTls ? 'secureConnect' : 'connect', () => socket.write(message));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 20) {
        const bodyLength = received.readUInt16BE(2);
        if (received.length >= 20 + bodyLength) {
          settle(() => resolve(received.subarray(0, 20 + bodyLength)));
        }
      }
    });
  });
}

function send(parsed: ParsedIceUrl, message: Buffer, timeoutMs: number): Promise<Buffer> {
  return parsed.transport === 'udp'
    ? sendUdp(parsed.host, parsed.port, message, timeoutMs)
    : sendStream(parsed.host, parsed.port, parsed.scheme === 'turns', message, timeoutMs);
}

export type IceCheckResult = { ok: true; latencyMs: number } | { ok: false; error: string };

async function checkTurnAllocate(
  parsed: ParsedIceUrl,
  username: string,
  credential: string,
  timeoutMs: number,
): Promise<IceCheckResult> {
  const start = Date.now();
  try {
    const firstResponseBuf = await send(parsed, buildAllocateRequest(randomBytes(12)), timeoutMs);
    const firstResponse = parseMessage(firstResponseBuf);
    if (!firstResponse) return { ok: false, error: 'Malformed STUN response' };

    if (firstResponse.type === MessageType.AllocateSuccess) {
      // Anonymous allocate succeeded (some open/misconfigured servers allow this).
      return { ok: true, latencyMs: Date.now() - start };
    }
    if (firstResponse.type !== MessageType.AllocateError) {
      return { ok: false, error: `Unexpected response type 0x${firstResponse.type.toString(16)}` };
    }

    const challenge = parseErrorCode(firstResponse.attrs);
    if (!challenge || challenge.code !== 401) {
      return {
        ok: false,
        error: challenge ? `TURN error ${challenge.code}: ${challenge.reason}` : 'Missing ERROR-CODE attribute',
      };
    }

    const realm = findAttr(firstResponse.attrs, AttrType.Realm)?.toString('utf8');
    const nonce = findAttr(firstResponse.attrs, AttrType.Nonce)?.toString('utf8');
    if (!realm || !nonce) return { ok: false, error: '401 challenge missing realm/nonce' };

    const key = createHash('md5').update(`${username}:${realm}:${credential}`).digest();
    const authedRequest = buildAllocateRequest(randomBytes(12), { username, realm, nonce, key });
    const secondResponseBuf = await send(parsed, authedRequest, timeoutMs);
    const secondResponse = parseMessage(secondResponseBuf);
    if (!secondResponse) return { ok: false, error: 'Malformed STUN response (authenticated)' };

    if (secondResponse.type === MessageType.AllocateSuccess) {
      return { ok: true, latencyMs: Date.now() - start };
    }

    const finalError = parseErrorCode(secondResponse.attrs);
    return {
      ok: false,
      error: finalError
        ? `TURN error ${finalError.code}: ${finalError.reason}`
        : `Unexpected response type 0x${secondResponse.type.toString(16)}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkStunBinding(parsed: ParsedIceUrl, timeoutMs: number): Promise<IceCheckResult> {
  const start = Date.now();
  try {
    const responseBuf = await send(parsed, buildBindingRequest(randomBytes(12)), timeoutMs);
    const response = parseMessage(responseBuf);
    if (!response) return { ok: false, error: 'Malformed STUN response' };
    if (response.type === MessageType.BindingSuccess) {
      return { ok: true, latencyMs: Date.now() - start };
    }
    const error = parseErrorCode(response.attrs);
    return { ok: false, error: error ? `STUN error ${error.code}: ${error.reason}` : 'Binding request failed' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Runs a real TURN Allocate handshake (or a plain STUN Binding check for a
// bare stun:/stuns: url) against one ICE server URL. `ok: true` means the
// given credentials actually produced a working relay allocation on that
// server, not just that the host:port was reachable.
export async function checkIceUrl(
  rawUrl: string,
  username: string,
  credential: string,
  timeoutMs = 4000,
): Promise<IceCheckResult> {
  const parsed = parseIceUrl(rawUrl);
  if (!parsed) return { ok: false, error: `Could not parse ICE URL: ${rawUrl}` };

  return parsed.scheme === 'stun' || parsed.scheme === 'stuns'
    ? checkStunBinding(parsed, timeoutMs)
    : checkTurnAllocate(parsed, username, credential, timeoutMs);
}
