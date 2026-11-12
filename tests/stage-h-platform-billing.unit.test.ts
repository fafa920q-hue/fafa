import { describe, expect, it } from 'vitest';
import {
  platformCost,
  platformModels,
  platformReserve,
} from '../packages/shared/src/platform-ai';

// Rates are USD micros per million tokens (packages/shared/src/platform-ai.ts).
// gpt-4.1-mini: input 400000, cached 100000, output 1600000.
// gpt-5.4-mini-2026-03-17: input 750000, cached 75000, output 4500000.
describe('platform billing arithmetic (stage H)', () => {
  it('lists the two configured models with the documented rates', () => {
    expect(platformModels['gpt-4.1-mini'].input).toBe(400000);
    expect(platformModels['gpt-4.1-mini'].cached).toBe(100000);
    expect(platformModels['gpt-4.1-mini'].output).toBe(1600000);
    expect(platformModels['gpt-5.4-mini-2026-03-17'].input).toBe(750000);
    expect(platformModels['gpt-5.4-mini-2026-03-17'].cached).toBe(75000);
    expect(platformModels['gpt-5.4-mini-2026-03-17'].output).toBe(4500000);
  });

  it('charges exactly input/output tokens with integer-micros ceiling (no float drift)', () => {
    // 1000 input (no cache) + 500 output on gpt-4.1-mini:
    // (1000*400000 + 500*1600000) / 1e6 = 1200 micros = $0.0012.
    expect(platformCost('gpt-4.1-mini', 1000, 0, 500)).toBe(1200);
    // Cached input is billed at the cached rate, not the full input rate.
    // (900*400000 + 100*100000 + 500*1600000) / 1e6 = 1170 micros.
    expect(platformCost('gpt-4.1-mini', 1000, 100, 500)).toBe(1170);
    // Zero usage costs zero.
    expect(platformCost('gpt-4.1-mini', 0, 0, 0)).toBe(0);
    // A single token is rounded up to 1 micro, never to zero or a fraction.
    expect(platformCost('gpt-4.1-mini', 1, 0, 0)).toBe(1);
  });

  it('reserve always covers a full-context call with the maximum output', () => {
    const reserve = platformReserve('gpt-4.1-mini', 4096);
    // context 262144 * 400000 (input rate) + 4096 * 1600000 (output rate), / 1e6.
    const expected =
      Math.ceil((262144 * 400000 + 4096 * 1600000) / 1000000);
    expect(reserve).toBe(expected);
    // The reserve equals the worst-case charge exactly (it is the maximum
    // possible cost of a full-context call with the maximum output), and it
    // covers every smaller call.
    expect(reserve).toBeGreaterThanOrEqual(
      platformCost('gpt-4.1-mini', 262144, 0, 4096),
    );
    expect(reserve).toBeGreaterThan(platformCost('gpt-4.1-mini', 1000, 0, 500));
  });
});
