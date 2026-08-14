'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Me = { username: string; verified: boolean } | null;

// The landing-page strip that replaces the old guest banner: shows Log in /
// Sign up for visitors, or the account name (with verification state) once
// logged in. 'loading' renders the guest layout without flashing wrong text.
export default function AuthBanner() {
  const router = useRouter();
  const [me, setMe] = useState<Me>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { user: null }))
      .then((data: { user: Me }) => {
        if (cancelled) return;
        setMe(data.user);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setMe(null);
    router.refresh();
  }

  if (loaded && me) {
    return (
      <div className="mx-auto mb-10 flex w-full max-w-xl items-center justify-between gap-4 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs backdrop-blur">
        <span className="flex items-center gap-2 text-white/70">
          <span className="text-base">🃏</span>
          <span className="text-white">{me.username}</span>
          {me.verified ? (
            <span className="rounded-full border border-lime-400/40 bg-lime-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-lime-300">
              ✓ Verified
            </span>
          ) : (
            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300">
              Unverified
            </span>
          )}
        </span>
        <button
          onClick={handleLogout}
          className="rounded-full border border-white/20 px-4 py-1.5 font-bold uppercase tracking-widest text-white/70 transition hover:border-red-500/60 hover:text-red-400"
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto mb-10 flex w-full max-w-xl items-center justify-between gap-4 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs backdrop-blur">
      <span className="flex items-center gap-2 text-white/70">
        <span className="text-base">👻</span>
        Playing as a <span className="text-white">Guest</span>.
      </span>
      <span className="flex items-center gap-2">
        <Link
          href="/auth"
          className="rounded-full border border-white/20 px-4 py-1.5 font-bold uppercase tracking-widest text-white/70 transition hover:border-white/40 hover:text-white"
        >
          Log in
        </Link>
        <Link
          href="/auth"
          className="rounded-full bg-lime-400 px-4 py-1.5 font-bold uppercase tracking-widest text-black transition hover:bg-lime-300"
        >
          Sign up
        </Link>
      </span>
    </div>
  );
}
