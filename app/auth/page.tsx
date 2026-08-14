'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { saveUsername } from '../lib/username';

type Mode = 'login' | 'register';

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mode === 'login'
            ? { identifier: username || email, password }
            : { username, email, password },
        ),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        user?: { username: string };
      } | null;
      if (!response.ok || !data?.user) {
        setError(data?.error ?? 'Something went wrong — try again.');
        return;
      }
      // Keep the arena/intro username in sync with the account name.
      saveUsername(data.user.username);
      router.push('/');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-[#07060a] font-mono text-white">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
        <Link
          href="/"
          className="mb-8 text-sm font-bold uppercase tracking-widest text-white/60 transition hover:text-lime-400"
        >
          ‹ Back
        </Link>

        <h1 className="mb-2 text-3xl font-black uppercase tracking-tight">
          {mode === 'login' ? 'Log in' : 'Create account'}
        </h1>
        <p className="mb-8 text-sm text-white/50">
          {mode === 'login'
            ? 'Welcome back, jester.'
            : 'Claim your name and start climbing the ranks.'}
        </p>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6"
        >
          <label className="block text-xs font-bold uppercase tracking-widest text-white/60">
            {mode === 'login' ? 'Username or email' : 'Username'}
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={mode === 'register' ? 20 : 254}
              autoComplete="username"
              placeholder={mode === 'login' ? 'jester42 or you@mail.com' : 'jester42'}
              className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400"
            />
          </label>

          {mode === 'register' && (
            <label className="block text-xs font-bold uppercase tracking-widest text-white/60">
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                placeholder="you@mail.com"
                className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400"
              />
            </label>
          )}

          <label className="block text-xs font-bold uppercase tracking-widest text-white/60">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              maxLength={72}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="••••••••"
              className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400"
            />
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-lime-400 px-6 py-3 text-sm font-black uppercase tracking-widest text-black transition hover:bg-lime-300 disabled:opacity-50"
          >
            {submitting ? 'One sec…' : mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode((current) => (current === 'login' ? 'register' : 'login'));
            setError('');
          }}
          className="mt-6 text-center text-xs uppercase tracking-widest text-white/50 transition hover:text-lime-400"
        >
          {mode === 'login' ? 'No account? Sign up ›' : 'Have an account? Log in ›'}
        </button>
      </div>
    </main>
  );
}
