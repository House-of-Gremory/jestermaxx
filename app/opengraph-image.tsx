import { ImageResponse } from 'next/og';

export const alt = 'Jester Maxing - live try-not-to-laugh duels';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 36,
          background: '#07060a',
          color: 'white',
          fontFamily: 'monospace',
          padding: 72,
        }}
      >
        <div style={{ color: '#d946ef', fontSize: 34 }}>LIVE 1V1 JESTER ARENA</div>
        <div style={{ display: 'flex', fontSize: 116, fontWeight: 900, lineHeight: 0.9 }}>
          JESTER<span style={{ color: '#a3e635' }}>MAXX</span>
        </div>
        <div style={{ maxWidth: 840, color: '#d6d3d1', fontSize: 38, lineHeight: 1.2 }}>
          Match with a stranger and try to make them laugh before they crack you first.
        </div>
      </div>
    ),
    size,
  );
}
