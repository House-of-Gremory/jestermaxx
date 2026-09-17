import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!client) {
    client = createClient(supabaseUrl, supabaseKey, {
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return client;
}

// Channel topic for signaling messages targeted at a specific participant.
export function signalChannelTopic(participantId: string): string {
  return `signal:${participantId}`;
}
