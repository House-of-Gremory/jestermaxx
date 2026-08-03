// Isomorphic metadata (safe for the client bundle) describing what config
// fields each TURN broker needs. The actual fetch logic lives in
// turn-providers.ts, which is server-only.

export type TurnProviderType = 'xirsys' | 'metered';

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
};
