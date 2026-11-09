// Standard-tier text pricing in USD micros per million tokens.
export const platformModels = {
  'gpt-4.1-mini': {
    context: 1047576,
    input: 400000,
    cached: 100000,
    output: 1600000,
  },
  'gpt-5.4-mini-2026-03-17': {
    context: 400000,
    input: 750000,
    cached: 75000,
    output: 4500000,
  },
} as const;
export type PlatformModel = keyof typeof platformModels;

export function platformAiEnabled() {
  return process.env.PLATFORM_CODEX_ENABLED === 'true';
}

export function platformReserve(model: PlatformModel, output: number) {
  const rate = platformModels[model];
  return Math.ceil(
    (rate.context * rate.input + output * rate.output) / 1_000_000,
  );
}

export function platformCost(
  model: PlatformModel,
  input: number,
  cached: number,
  output: number,
) {
  const rate = platformModels[model];
  return Math.ceil(
    ((input - cached) * rate.input +
      cached * rate.cached +
      output * rate.output) /
      1_000_000,
  );
}
