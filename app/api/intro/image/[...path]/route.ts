import { readIntroImage } from '@/lib/intro-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const imagePath = segments.join('/');

  try {
    const buffer = await readIntroImage(imagePath);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/jpeg',
        // Filenames are UUID-based, so a successful fetch is safe to cache forever.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
