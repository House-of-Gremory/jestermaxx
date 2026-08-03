import { withDatabase, type TurnProviderRecord } from '@/lib/db';
import { TURN_PROVIDER_TYPES, type TurnProviderType } from '@/lib/turn-provider-types';
import { resolveTurnProvider } from '@/lib/turn-providers';
import { checkIceUrl } from '@/lib/turn-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHECK_TIMEOUT_MS = 4000;

export async function GET() {
  const providers = await withDatabase((database) => database.data.turnProviders);
  return Response.json({ providers });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { label?: string; type?: string; config?: Record<string, string> }
    | null;

  const type = body?.type;
  if (!type || !(type in TURN_PROVIDER_TYPES)) {
    return Response.json({ error: 'Unknown provider type' }, { status: 400 });
  }
  const providerType = type as TurnProviderType;

  const config: Record<string, string> = {};
  for (const field of TURN_PROVIDER_TYPES[providerType].fields) {
    const value = body?.config?.[field.key]?.trim();
    if (!value) return Response.json({ error: `${field.label} is required` }, { status: 400 });
    config[field.key] = value;
  }

  let resolved;
  try {
    resolved = await resolveTurnProvider(providerType, config);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch credentials from provider' },
      { status: 400 },
    );
  }

  // Verify the resolved credentials actually work before saving, same as the
  // static pool's live TURN Allocate check.
  let bestLatencyMs: number | null = null;
  let lastError: string | null = null;
  for (const url of resolved.urls) {
    const result = await checkIceUrl(url, resolved.username, resolved.credential, CHECK_TIMEOUT_MS);
    if (result.ok) {
      if (bestLatencyMs === null || result.latencyMs < bestLatencyMs) bestLatencyMs = result.latencyMs;
    } else {
      lastError = result.error;
    }
  }

  const record: TurnProviderRecord = {
    id: `turn-provider-${crypto.randomUUID()}`,
    label: body?.label?.trim() || TURN_PROVIDER_TYPES[providerType].label,
    type: providerType,
    config,
    urls: resolved.urls,
    username: resolved.username,
    credential: resolved.credential,
    expiresAt: resolved.expiresAt,
    createdAt: Date.now(),
    status: bestLatencyMs !== null ? 'up' : 'down',
    latencyMs: bestLatencyMs,
    lastCheckedAt: Date.now(),
    lastError,
  };

  await withDatabase((database) => {
    database.data.turnProviders.push(record);
  });

  return Response.json({ provider: record }, { status: 201 });
}
