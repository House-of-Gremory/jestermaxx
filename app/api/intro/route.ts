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
    slides: record.slides.map((slide) => ({
      ...slide,
      url: slide.imagePath ? introImageUrl(slide.imagePath) : '',
    })),
  };
}

// Uploads pending base64 images to R2 on-demand when another player requests
// this intro. Returns the updated record with R2 URLs.
async function uploadPendingImages(record: IntroRecord): Promise<IntroRecord> {
  const hasPending = record.slides.some((s) => s.pendingDataUrl && !s.imagePath);
  if (!hasPending) return record;

  const updatedSlides = await Promise.all(
    record.slides.map(async (slide, index) => {
      if (slide.imagePath || !slide.pendingDataUrl) return slide;
      const imagePath = await saveIntroImage(record.username, index, slide.pendingDataUrl);
      return { ...slide, imagePath, pendingDataUrl: undefined };
    }),
  );

  const updated = { ...record, slides: updatedSlides };
  await withDatabase((database) => {
    const idx = database.data.intros.findIndex((i) => i.username === record.username);
    if (idx !== -1) database.data.intros[idx] = updated;
  });

  return updated;
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
    // Store images as pending base64 data URLs in the database instead of
    // uploading to R2 immediately. The upload is deferred until another
    // player requests this intro (GET /api/intro).
    slides = body.slides.map((slide, index) => ({
      imagePath: '',
      text: (slide.text ?? '').slice(0, 80),
      xPct: clampPct(slide.xPct, 50),
      yPct: clampPct(slide.yPct, 85),
      pendingDataUrl: slide.dataUrl!,
    }));
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

  let record = await withDatabase((database) =>
    database.data.intros.find((intro) => intro.username === username),
  );

  // When another player requests this intro, upload pending images to R2
  // on-demand so they're available via public URL.
  if (record) {
    record = await uploadPendingImages(record);
  }

  return Response.json({ intro: record ? resolveIntro(record) : null });
}

// Deletes a guest's intro record from the database. Called when a guest
// explicitly leaves their session so their photos/username are removed.
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const username = url.searchParams.get('username')?.trim();
  if (!username) {
    return Response.json({ error: 'username is required' }, { status: 400 });
  }

  await withDatabase((database) => {
    database.data.intros = database.data.intros.filter(
      (intro) => intro.username.toLowerCase() !== username.toLowerCase(),
    );
  });

  return Response.json({ ok: true });
}
