'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { TurnServerRecord } from '@/lib/db';

const STATUS_STYLES: Record<TurnServerRecord['status'], string> = {
  up: 'bg-lime-400/15 text-lime-300 border-lime-400/30',
  down: 'bg-red-500/15 text-red-300 border-red-500/30',
  unknown: 'bg-white/10 text-white/50 border-white/20',
};

function formatLastChecked(ts: number | null) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString();
}

export default function AdminTurnServersPage() {
  const router = useRouter();
  const [servers, setServers] = useState<TurnServerRecord[] | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [label, setLabel] = useState('');
  const [urls, setUrls] = useState('');
  const [username, setUsername] = useState('');
  const [credential, setCredential] = useState('');

  async function loadServers() {
    const response = await fetch('/api/admin/turn-servers');
    if (!response.ok) {
      setError('Failed to load TURN servers');
      return;
    }
    const data = (await response.json()) as { servers: TurnServerRecord[] };
    setServers(data.servers);
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/turn-servers')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load TURN servers');
        return response.json() as Promise<{ servers: TurnServerRecord[] }>;
      })
      .then((data) => {
        if (!cancelled) setServers(data.servers);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load TURN servers');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/admin/turn-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, urls, username, credential }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(data?.error ?? 'Failed to add TURN server');
        return;
      }
      setLabel('');
      setUrls('');
      setUsername('');
      setCredential('');
      await loadServers();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError('');
    const response = await fetch(`/api/admin/turn-servers/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('Failed to delete TURN server');
      return;
    }
    await loadServers();
  }

  async function handleCheckNow() {
    setChecking(true);
    setError('');
    try {
      const response = await fetch('/api/admin/turn-servers/check-now', { method: 'POST' });
      if (!response.ok) {
        setError('Health check failed to run');
        return;
      }
      await loadServers();
    } finally {
      setChecking(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    router.push('/admin/login');
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-[#07060a] px-4 py-10 font-mono text-white">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-lg font-bold uppercase tracking-[0.3em] text-lime-400">TURN Servers</h1>
          <button
            onClick={handleLogout}
            className="rounded-full border border-white/20 px-4 py-1.5 text-xs uppercase tracking-widest text-white/70 transition hover:border-fuchsia-400 hover:text-fuchsia-300"
          >
            Log out
          </button>
        </div>

        {error && (
          <p className="mb-6 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        <form
          onSubmit={handleAdd}
          className="mb-10 grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-6 sm:grid-cols-2"
        >
          <label className="block text-xs uppercase tracking-widest text-white/50 sm:col-span-2">
            Label (optional)
            <input
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-lime-400"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. relay1-eu"
            />
          </label>

          <label className="block text-xs uppercase tracking-widest text-white/50 sm:col-span-2">
            Server URLs (one per line)
            <textarea
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-lime-400"
              value={urls}
              onChange={(event) => setUrls(event.target.value)}
              placeholder={'turn:relay.example.com:3478?transport=udp\nturns:relay.example.com:5349'}
              rows={3}
              required
            />
          </label>

          <label className="block text-xs uppercase tracking-widest text-white/50">
            Username
            <input
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-lime-400"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>

          <label className="block text-xs uppercase tracking-widest text-white/50">
            Credential
            <input
              type="password"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-lime-400"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              required
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-lime-400 px-4 py-2 text-sm font-bold uppercase tracking-widest text-black transition hover:bg-lime-300 disabled:opacity-50 sm:col-span-2"
          >
            {submitting ? 'Adding…' : 'Add TURN server'}
          </button>
        </form>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-widest text-white/50">
            Pool ({servers?.length ?? 0}) — best to worst
          </h2>
          <button
            onClick={handleCheckNow}
            disabled={checking}
            className="rounded-full border border-white/20 px-4 py-1.5 text-xs uppercase tracking-widest text-white/70 transition hover:border-lime-400 hover:text-lime-300 disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase tracking-widest text-white/50">
              <tr>
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">URLs</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Latency</th>
                <th className="px-4 py-3">Last checked</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {servers === null && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-white/40">
                    Loading…
                  </td>
                </tr>
              )}
              {servers?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-white/40">
                    No TURN servers yet — add one above.
                  </td>
                </tr>
              )}
              {servers?.map((server) => (
                <tr key={server.id} className="border-t border-white/10 align-top">
                  <td className="px-4 py-3 font-bold">{server.label}</td>
                  <td className="px-4 py-3 text-white/60">
                    {server.urls.map((url) => (
                      <div key={url} className="whitespace-nowrap">
                        {url}
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs uppercase tracking-widest ${STATUS_STYLES[server.status]}`}
                    >
                      {server.status}
                    </span>
                    {server.lastError && (
                      <div className="mt-1 max-w-xs text-xs text-red-300/80">{server.lastError}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {server.latencyMs !== null ? `${server.latencyMs} ms` : '—'}
                  </td>
                  <td className="px-4 py-3 text-white/60">{formatLastChecked(server.lastCheckedAt)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="text-xs uppercase tracking-widest text-red-300/70 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
