import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

// Local-disk storage for intro reel photos. This is the only module that
// knows where the bytes live, so moving to Cloudflare later means changing
// only saveIntroImage/introImageUrl/readIntroImage — nothing else in the app.
const STORAGE_ROOT = path.join(process.cwd(), 'data', 'intros');

function slugifyUsername(username: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'player';
}

function parseImageDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a base64 image data URL');
  return Buffer.from(match[1], 'base64');
}

// Returns an opaque imagePath id (relative to STORAGE_ROOT) to store in the DB.
export async function saveIntroImage(
  username: string,
  index: number,
  dataUrl: string,
): Promise<string> {
  const buffer = parseImageDataUrl(dataUrl);
  const slug = slugifyUsername(username);
  const dir = path.join(STORAGE_ROOT, slug);
  await mkdir(dir, { recursive: true });

  const filename = `${index}-${randomUUID()}.jpg`;
  await writeFile(path.join(dir, filename), buffer);
  return `${slug}/${filename}`;
}

export function introImageUrl(imagePath: string): string {
  return `/api/intro/image/${imagePath}`;
}

// Filenames are UUID-based, but guard against a malformed/tampered path
// escaping the storage root before touching the filesystem.
export async function readIntroImage(imagePath: string): Promise<Buffer> {
  const resolved = path.join(STORAGE_ROOT, imagePath);
  if (resolved !== STORAGE_ROOT && !resolved.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error('Invalid image path');
  }
  return readFile(resolved);
}
