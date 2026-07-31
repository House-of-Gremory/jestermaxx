import { withDatabase } from '@/lib/db';
import { checkAllTurnServers } from '@/lib/turn-check';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  await checkAllTurnServers();
  const servers = await withDatabase((database) => database.data.turnServers);
  return Response.json({ servers });
}
