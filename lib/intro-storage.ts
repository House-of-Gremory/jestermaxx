import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

// Cloudflare R2 storage for intro reel photos. This is the only module that
// knows where the bytes live, so swapping storage backends later means
// changing only saveIntroImage/introImageUrl — nothing else in the app.
const R2_BUCKET = process.env.R2_BUCKET!;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

function slugifyUsername(username: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'player';
}

function parseImageDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a base64 image data URL');
  return Buffer.from(match[1], 'base64');
}

// Returns an opaque imagePath id (the R2 object key) to store in the DB.
export async function saveIntroImage(
  username: string,
  index: number,
  dataUrl: string,
): Promise<string> {
  const buffer = parseImageDataUrl(dataUrl);
  const slug = slugifyUsername(username);
  const filename = `${index}-${randomUUID()}.jpg`;
  const key = `intros/${slug}/${filename}`;

  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return key;
}

export function introImageUrl(imagePath: string): string {
  return `${R2_PUBLIC_URL}/${imagePath}`;
}
