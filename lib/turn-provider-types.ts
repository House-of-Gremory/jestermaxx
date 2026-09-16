// Isomorphic metadata (safe for the client bundle) describing what config
// fields each TURN broker needs. The actual fetch logic lives in
// turn-providers.ts, which is server-only.

export type TurnProviderType = 'xirsys' | 'metered' | 'cloudflare';

export type TurnProviderField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
};

export const TURN_PROVIDER_TYPES: Record<TurnProviderType, { label: string; fields: TurnProviderField[] }> = {
  xirsys: {
    label: 'Xirsys',
    fields: [
      { key: 'ident', label: 'Ident', placeholder: 'e.g. scelester' },
      { key: 'secret', label: 'Secret', secret: true },
      { key: 'channel', label: 'Channel', placeholder: 'e.g. channel6b795748' },
    ],
  },
  metered: {
    label: 'Metered',
    fields: [
      { key: 'subdomain', label: 'Subdomain', placeholder: 'e.g. jestermaxing' },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
  },
  cloudflare: {
    label: 'Cloudflare Realtime TURN',
    fields: [
      { key: 'turnTokenId', label: 'TURN Token ID', placeholder: 'e.g. 86167cd106b1014bae0881ad85369d26' },
      { key: 'apiToken', label: 'API token', secret: true },
    ],
  },
};
