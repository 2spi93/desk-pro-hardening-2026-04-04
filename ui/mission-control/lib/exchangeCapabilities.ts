type JsonMap = Record<string, unknown>;

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asText(value: unknown): string {
  return String(value || "").trim();
}

function normalizeProvider(value: unknown): string {
  return asText(value).toLowerCase();
}

export type ExchangeCapability = {
  provider: string;
  known: boolean;
  data: boolean;
  execution: boolean;
  l2: boolean;
  l3: boolean;
  preferred_venue: string;
  execution_venue: string;
  api_key_requires_passphrase: boolean;
  capability_source: string;
};

function fallbackCapability(provider: string): ExchangeCapability {
  return {
    provider,
    known: false,
    data: false,
    execution: false,
    l2: false,
    l3: false,
    preferred_venue: "",
    execution_venue: "",
    api_key_requires_passphrase: false,
    capability_source: "fallback",
  };
}

export function normalizeExchangeCapability(value: unknown): ExchangeCapability {
  const raw = asMap(value);
  const provider = normalizeProvider(raw.provider);
  return {
    provider,
    known: asBool(raw.known, Boolean(provider)),
    data: asBool(raw.data),
    execution: asBool(raw.execution),
    l2: asBool(raw.l2),
    l3: asBool(raw.l3),
    preferred_venue: asText(raw.preferred_venue),
    execution_venue: asText(raw.execution_venue),
    api_key_requires_passphrase: asBool(raw.api_key_requires_passphrase),
    capability_source: asText(raw.capability_source) || "exchange-capabilities",
  };
}

export function normalizeExchangeCapabilityMap(payload: unknown): Record<string, ExchangeCapability> {
  const envelope = asMap(payload);
  const byProvider = asMap(envelope.by_provider);
  const result: Record<string, ExchangeCapability> = {};

  for (const [providerKey, value] of Object.entries(byProvider)) {
    const normalized = normalizeExchangeCapability({ ...asMap(value), provider: providerKey });
    if (normalized.provider) {
      result[normalized.provider] = normalized;
    }
  }

  const providerRows = Array.isArray(envelope.providers) ? envelope.providers : [];
  for (const item of providerRows) {
    const normalized = normalizeExchangeCapability(item);
    if (normalized.provider && !result[normalized.provider]) {
      result[normalized.provider] = normalized;
    }
  }

  return result;
}

export function getExchangeCapability(
  capabilities: Record<string, ExchangeCapability>,
  provider: string,
): ExchangeCapability {
  const providerKey = normalizeProvider(provider);
  return capabilities[providerKey] || fallbackCapability(providerKey);
}

export function suggestedExchangeVenue(
  capability: ExchangeCapability,
  liveEnabled: boolean,
  fallbackVenue = "",
): string {
  if (liveEnabled && capability.execution && capability.execution_venue) {
    return capability.execution_venue;
  }
  if (capability.preferred_venue) {
    return capability.preferred_venue;
  }
  return asText(fallbackVenue);
}