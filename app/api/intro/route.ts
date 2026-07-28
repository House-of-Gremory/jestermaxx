import { withDatabase, type IntroRecord, type IntroSlide } from '@/lib/db';
import { introImageUrl, saveIntroImage } from '@/lib/intro-storage';
import { isTransitionId, SLIDE_COUNT, type IntroRecordResolved, type TransitionId } from '@/lib/intro-templates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type IntroSlideInput = { dataUrl?: string; text?: string; xPct?: number; yPct?: number };
type IntroPostBody = {
  username?: string;
  transitionId?: string;
  slides?: IntroSlideInput[];
};

function resolveIntro(record: IntroRecord): IntroRecordResolved {
  return {
    ...record,
    transitionId: record.transitionId as TransitionId,
    slides: record.slides.map((slide) => ({ ...slide, url: introImageUrl(slide.imagePath) })),
  };
}

function clampPct(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(100, Math.max(0, n));
}

export async function POST(request: Request) {
  const body = (await request.json()) as IntroPostBody;

  const username = body.username?.trim();
  if (!username || username.length > 32) {
    return Response.json({ error: 'Username must be 1-32 characters' }, { status: 400 });
  }
  if (!Array.isArray(body.slides) || body.slides.length !== SLIDE_COUNT) {
    return Response.json({ error: `Exactly ${SLIDE_COUNT} slides are required` }, { status: 400 });
  }
  if (!isTransitionId(body.transitionId)) {
    return Response.json({ error: 'Invalid transitionId' }, { status: 400 });
  }
  if (body.slides.some((slide) => !slide.dataUrl?.startsWith('data:image/'))) {
    return Response.json({ error: 'Every slide needs an image data URL' }, { status: 400 });
  }

  let slides: IntroSlide[];
  try {
    slides = await Promise.all(
      body.slides.map(async (slide, index) => ({
        imagePath: await saveIntroImage(username, index, slide.dataUrl!),
        text: (slide.text ?? '').slice(0, 80),
        xPct: clampPct(slide.xPct, 50),
        yPct: clampPct(slide.yPct, 85),
      })),
    );
  } catch {
    return Response.json({ error: 'Could not save intro images' }, { status: 400 });
  }

  const record: IntroRecord = {
    username,
    slides,
    transitionId: body.transitionId,
    createdAt: Date.now(),
  };

  await withDatabase((database) => {
    database.data.intros = database.data.intros.filter((intro) => intro.username !== username);
    database.data.intros.push(record);
  });

  return Response.json({ intro: resolveIntro(record) });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const username = url.searchParams.get('username')?.trim();
  if (!username) {
    return Response.json({ error: 'username is required' }, { status: 400 });
  }

  const record = await withDatabase((database) =>
    database.data.intros.find((intro) => intro.username === username),
  );

  return Response.json({ intro: record ? resolveIntro(record) : null });
}
