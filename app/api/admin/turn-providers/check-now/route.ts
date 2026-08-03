import { withDatabase } from '@/lib/db';
import { refreshAllTurnProviders } from '@/lib/turn-check';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  await refreshAllTurnProviders(true);
  const providers = await withDatabase((database) => database.data.turnProviders);
  return Response.json({ providers });
}
