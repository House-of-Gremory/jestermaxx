'use client';

import { useEffect, useRef, useState } from 'react';

const COLORS = ['#a3e635', '#f472b6', '#38bdf8', '#facc15', '#fb923c', '#c084fc'];

export default function DvdBounce({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [color, setColor] = useState(COLORS[0]);
  const stateRef = useRef({ x: 50, y: 50, vx: 1.0, vy: 0.7, color });

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const s = stateRef.current;
      const el = containerRef.current;
      if (!el) { raf = requestAnimationFrame(tick); return; }

      const w = el.clientWidth;
      const h = el.clientHeight;
      const textW = 220;
      const textH = 48;

      s.x += s.vx;
      s.y += s.vy;

      let hit = false;
      if (s.x <= 0 || s.x >= w - textW) { s.vx *= -1; s.x = Math.max(0, Math.min(s.x, w - textW)); hit = true; }
      if (s.y <= 0 || s.y >= h - textH) { s.vy *= -1; s.y = Math.max(0, Math.min(s.y, h - textH)); hit = true; }

      if (hit) {
        s.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        setColor(s.color);
      }

      setPos({ x: s.x, y: s.y });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className ?? ''}`}>
      <span
        className="pointer-events-none absolute select-none text-3xl font-black uppercase tracking-widest"
        style={{
          left: pos.x,
          top: pos.y,
          color,
          textShadow: `0 0 20px ${color}40, 0 0 60px ${color}20`,
        }}
      >
        JESTERMAX
      </span>
    </div>
  );
}
