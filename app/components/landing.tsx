import Link from 'next/link';

const STEPS = [
  {
    n: '1',
    emoji: '📷',
    title: 'BUILD YOUR INTRO',
    body: 'Snap 4 photos, caption them, pick a transition — it doubles as your camera check.',
  },
  {
    n: '2',
    emoji: '🃏',
    title: 'Jester maxxing rule',
    body: 'Make your opponent giggle',
  },
  {
    n: '3',
    emoji: '⚔️',
    title: 'COMPETE AND CLIMB THE RANKS',
    body: 'Win matches, earn points, and climb the ladder.',
  },
];

export default function Landing() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#07060a] text-white font-mono selection:bg-lime-400 selection:text-black">
      {/* neon grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(163,230,53,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(217,70,239,0.08) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black 40%, transparent 85%)',
        }}
      />
      {/* glow blobs */}
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-fuchsia-600/30 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute top-40 -right-24 h-[340px] w-[340px] rounded-full bg-lime-400/20 blur-[120px]" />

      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-6">
        {/* guest banner */}
        <div className="mx-auto mb-10 flex w-full max-w-xl items-center justify-between gap-4 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs backdrop-blur">
          <span className="flex items-center gap-2 text-white/70">
            <span className="text-base">👻</span>
            Playing as a <span className="text-white">Guest</span>. Claim your rank.
          </span>
          <button className="rounded-full bg-lime-400 px-4 py-1.5 font-bold uppercase tracking-widest text-black transition hover:bg-lime-300">
            Claim
          </button>
        </div>

        {/* hero */}
        <section className="flex flex-col items-center text-center">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.3em] text-fuchsia-300">
            ⚔️ Live 1v1 Jester Arena
          </span>

          <h1
            className="text-6xl font-black uppercase leading-none tracking-tight sm:text-8xl"
            style={{
              textShadow:
                '0 0 24px rgba(163,230,53,0.55), 0 0 60px rgba(217,70,239,0.45)',
            }}
          >
            JESTER<span className="text-lime-400">MAXX</span>
          </h1>

          <p className="mt-5 flex items-center gap-2 text-sm uppercase tracking-[0.3em] text-white/60">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-lime-400" />
            </span>
            1400 Online
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/intro"
              className="rounded-xl bg-lime-400 px-8 py-3.5 text-sm font-black uppercase tracking-widest text-black shadow-[0_0_30px_rgba(163,230,53,0.5)] transition hover:-translate-y-0.5 hover:bg-lime-300"
            >
              Enter the Arena
            </Link>
            <Link
              href="/intro"
              className="rounded-xl border border-white/20 bg-white/5 px-8 py-3.5 text-sm font-bold uppercase tracking-widest text-white/80 backdrop-blur transition hover:border-white/40 hover:text-white"
            >
              Build Your Intro
            </Link>
          </div>
        </section>

        {/* steps */}
        <section className="mt-20 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-lime-400/50 hover:bg-white/[0.06]"
            >
              <span className="absolute right-4 top-4 text-5xl font-black text-white/5 transition group-hover:text-lime-400/20">
                {s.n}
              </span>
              <div className="mb-4 text-3xl">{s.emoji}</div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-widest text-white">
                {s.title}
              </h3>
              <p className="text-sm leading-relaxed text-white/50">{s.body}</p>
            </div>
          ))}
        </section>

        {/* leaderboard teaser */}
        <section className="mt-6">
          <div className="flex items-center justify-between rounded-2xl border border-fuchsia-500/30 bg-gradient-to-r from-fuchsia-500/10 to-lime-400/5 p-6">
            <div className="flex items-center gap-4">
              <span className="text-3xl">🏆</span>
              <div>
                <h3 className="text-sm font-bold uppercase tracking-widest">
                  View Leaderboard
                </h3>
                <p className="text-sm text-white/50">
                  See top players and rankings.
                </p>
              </div>
            </div>
            <span className="text-2xl text-white/40">›</span>
          </div>
        </section>

        {/* footer */}
        <footer className="mt-auto pt-16 text-center text-[11px] uppercase tracking-[0.25em] text-white/30">
          Privacy Policy · Terms of Use · Settings
        </footer>
      </div>
    </main>
  );
}
