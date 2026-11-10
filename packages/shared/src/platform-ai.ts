export type PlatformRate = {
  context: number;
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
};

// Default standard short-context rates in USD micros per million tokens.
export const platformModels = {
  'gpt-4.1-mini': {
    context: 262144,
    input: 400000,
    cached: 100000,
    output: 1600000,
  },
  'gpt-5.4-mini-2026-03-17': {
    context: 262144,
    input: 750000,
    cached: 75000,
    output: 4500000,
  },
} as const satisfies Record<string, PlatformRate>;
export type PlatformModel = keyof typeof platformModels;

export function platformAiEnabled() {
  return process.env.PLATFORM_AI_ENABLED === 'true';
}

export function platformReserve(
  model: PlatformModel | PlatformRate,
  output: number,
) {
  const rate: PlatformRate =
    typeof model === 'string' ? platformModels[model] : model;
  return Math.ceil(
    (rate.context * Math.max(rate.input, rate.cacheWrite ?? 0) +
      output * rate.output) /
      1_000_000,
  );
}

export function platformCost(
  model: PlatformModel | PlatformRate,
  input: number,
  cached: number,
  output: number,
  cacheWrite = 0,
) {
  const rate: PlatformRate =
    typeof model === 'string' ? platformModels[model] : model;
  return Math.ceil(
    ((input - cached - cacheWrite) * rate.input +
      cached * rate.cached +
      cacheWrite * (rate.cacheWrite ?? rate.input) +
      output * rate.output) /
      1_000_000,
  );
}
