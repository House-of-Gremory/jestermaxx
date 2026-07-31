'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

type Family = 'IPv4' | 'IPv6' | 'mDNS' | 'unknown';

type CandidateInfo = {
  type: string; // host | srflx | prflx | relay
  protocol: string; // udp | tcp
  family: Family;
  address: string;
  port: number;
};

const GATHER_TIMEOUT_MS = 8000;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

function classifyAddress(address: string): Family {
  if (address.endsWith('.local')) return 'mDNS';
  if (address.includes(':')) return 'IPv6';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return 'IPv4';
  return 'unknown';
}

function isPublicIPv4(address: string) {
  return !PRIVATE_V4.some((re) => re.test(address));
}

function isPublicIPv6(address: string) {
  const lower = address.toLowerCase();
  return lower !== '::1' && !lower.startsWith('fe80') && !lower.startsWith('fc') && !lower.startsWith('fd');
}

// Gathers real ICE candidates against the same pool video-call.tsx uses, so
// this reflects what an actual call would see — not a synthetic STUN probe.
async function gatherCandidates(iceServers: RTCIceServer[]): Promise<CandidateInfo[]> {
  const pc = new RTCPeerConnection({ iceServers });
  const candidates: CandidateInfo[] = [];
  pc.createDataChannel('probe');

  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    };
  });

  pc.onicecandidate = (event) => {
    const c = event.candidate;
    if (!c || !c.address) return;
    candidates.push({
      type: c.type ?? 'unknown',
      protocol: c.protocol ?? 'unknown',
      family: classifyAddress(c.address),
      address: c.address,
      port: c.port ?? 0,
    });
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
  } finally {
    pc.close();
  }

  return candidates;
}

function summarize(candidates: CandidateInfo[]) {
  const hasIPv4Host = candidates.some((c) => c.type === 'host' && c.family === 'IPv4');
  const hasPublicIPv6Host = candidates.some(
    (c) => c.type === 'host' && c.family === 'IPv6' && isPublicIPv6(c.address),
  );
  const hasIPv4Srflx = candidates.some(
    (c) => c.type === 'srflx' && c.family === 'IPv4' && isPublicIPv4(c.address),
  );
  const hasIPv6Srflx = candidates.some((c) => c.type === 'srflx' && c.family === 'IPv6');
  const relayCandidates = candidates.filter((c) => c.type === 'relay');
  const hasMdnsOnly = candidates.some((c) => c.type === 'host' && c.family === 'mDNS');

  return { hasIPv4Host, hasPublicIPv6Host, hasIPv4Srflx, hasIPv6Srflx, relayCandidates, hasMdnsOnly };
}

const FAMILY_STYLES: Record<Family, string> = {
  IPv4: 'bg-white/10 text-white/70 border-white/20',
  IPv6: 'bg-lime-400/15 text-lime-300 border-lime-400/30',
  mDNS: 'bg-fuchsia-400/15 text-fuchsia-300 border-fuchsia-400/30',
  unknown: 'bg-white/10 text-white/50 border-white/20',
};

export default function NetworkCheckPage() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<CandidateInfo[] | null>(null);
  const [poolLabels, setPoolLabels] = useState<string[] | null>(null);

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError('');
    setCandidates(null);
    try {
      const response = await fetch('/api/turn-credentials');
      if (!response.ok) throw new Error('Failed to load ICE server pool');
      const data = (await response.json()) as { iceServers?: RTCIceServer[] };
      const iceServers = data.iceServers ?? [];
      setPoolLabels(
        iceServers.map((entry) => (Array.isArray(entry.urls) ? entry.urls.join(', ') : entry.urls)),
      );
      const result = await gatherCandidates(iceServers);
      setCandidates(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network check failed');
    } finally {
      setRunning(false);
    }
  }, []);

  const summary = candidates ? summarize(candidates) : null;

  return (
    <main className="min-h-screen bg-[#07060a] px-4 py-10 font-mono text-white">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-lg font-bold uppercase tracking-[0.3em] text-lime-400">Network Check</h1>
          <Link
            href="/admin"
            className="rounded-full border border-white/20 px-4 py-1.5 text-xs uppercase tracking-widest text-white/70 transition hover:border-lime-400 hover:text-lime-300"
          >
            Back to TURN servers
          </Link>
        </div>

        <p className="mb-6 text-sm text-white/50">
          Gathers real ICE candidates in this browser against the pool <code>/api/turn-credentials</code>{' '}
          currently returns (self-hosted TURN, Xirsys, then fallback STUN) — the same pool{' '}
          <code>video-call.tsx</code> uses. This tells you what this specific connection can actually do,
          not just what the server-side TURN health check reports.
        </p>

        <button
          onClick={() => void runCheck()}
          disabled={running}
          className="mb-8 rounded-full bg-lime-400 px-5 py-2 text-sm font-bold uppercase tracking-widest text-black transition hover:bg-lime-300 disabled:opacity-50"
        >
          {running ? 'Gathering…' : 'Run check'}
        </button>

        {error && <p className="mb-6 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

        {poolLabels && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-6">
            <h2 className="mb-3 text-sm uppercase tracking-widest text-white/50">ICE servers tested</h2>
            {poolLabels.length === 0 ? (
              <p className="text-sm text-white/40">No ICE servers configured.</p>
            ) : (
              <ul className="space-y-1 text-sm text-white/60">
                {poolLabels.map((label, i) => (
                  <li key={i} className="whitespace-nowrap">
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {summary && (
          <div className="mb-8 grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-6 sm:grid-cols-2">
            <SummaryLine ok={summary.hasIPv4Host} label="IPv4 host candidate" />
            <SummaryLine ok={summary.hasPublicIPv6Host} label="Public IPv6 host candidate" />
            <SummaryLine ok={summary.hasIPv4Srflx} label="STUN reachable over IPv4 (srflx)" />
            <SummaryLine ok={summary.hasIPv6Srflx} label="STUN reachable over IPv6 (srflx)" />
            <SummaryLine
              ok={summary.relayCandidates.length > 0}
              label={`TURN relay reachable${summary.relayCandidates.length ? ` (${summary.relayCandidates.length})` : ''}`}
            />
            {summary.hasMdnsOnly && (
              <p className="text-xs text-fuchsia-300/80 sm:col-span-2">
                Host candidates are mDNS-obfuscated (browser privacy feature) — real LAN address is hidden,
                this is normal and unrelated to public reachability.
              </p>
            )}
            <p className="text-sm text-white/70 sm:col-span-2">
              {summary.relayCandidates.length > 0
                ? 'TURN relay confirmed working — this connection has a fallback path even across strict NATs/firewalls.'
                : summary.hasPublicIPv6Host
                  ? 'No TURN relay available, but a public IPv6 host candidate was found — direct P2P may work against another public-IPv6 peer, with no fallback if that fails.'
                  : summary.hasIPv4Srflx
                    ? 'No TURN relay available. STUN found a public IPv4 address, so direct P2P may work if the peer is not behind a symmetric NAT — but there is no relay fallback if it is.'
                    : 'No TURN relay, no public IPv6 host, and no working STUN srflx candidate — this connection likely cannot establish a peer connection at all right now.'}
            </p>
          </div>
        )}

        {candidates && (
          <div className="overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-widest text-white/50">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Family</th>
                  <th className="px-4 py-3">Protocol</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3">Port</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-white/40">
                      No candidates gathered.
                    </td>
                  </tr>
                )}
                {candidates.map((c, i) => (
                  <tr key={i} className="border-t border-white/10">
                    <td className="px-4 py-3 font-bold">{c.type}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs uppercase tracking-widest ${FAMILY_STYLES[c.family]}`}
                      >
                        {c.family}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/60">{c.protocol}</td>
                    <td className="px-4 py-3 text-white/60">{c.address}</td>
                    <td className="px-4 py-3 text-white/60">{c.port}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function SummaryLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-lime-400' : 'bg-red-500'}`}
        aria-hidden
      />
      <span className={ok ? 'text-white/80' : 'text-white/50'}>{label}</span>
    </div>
  );
}
