import { D, minorUnitsToUsd, type DecimalValue } from "@touchstone/sdk";

/**
 * Realized inference spend, totalled without floating point (invariant 4). Each call's exact cost (callCostUsd's decimal string) is added
 * exactly; a total is read as integer micro-dollars, rounded half-up once, at that point. Rounding each call to micro-dollars first would round
 * before publication, and a call's exact cost carries digits below a micro-dollar (3 prompt tokens at $0.25 per 1M is $0.00000075). Each
 * provider's total is rounded from its own exact sum, so the provider totals can differ from the overall total by up to half a micro-dollar
 * each. Until 2026-11-21 the loops summed Number(cost) and printed toFixed(6), which could misstate a total.
 */
export class SpendTally {
  #total: DecimalValue = new D(0);
  readonly #byProvider = new Map<string, DecimalValue>();

  add(usd: string, provider?: string): void {
    let amount: DecimalValue;
    try {
      amount = new D(usd);
    } catch {
      throw new Error(`A call's cost must be a decimal amount of dollars, got "${usd}".`);
    }
    if (!amount.isFinite() || amount.isNegative()) throw new Error(`A call's cost must be a non-negative decimal amount of dollars, got "${usd}".`);
    this.#total = this.#total.plus(amount);
    if (provider !== undefined) this.#byProvider.set(provider, (this.#byProvider.get(provider) ?? new D(0)).plus(amount));
  }

  totalMicroUsd(): bigint {
    return toMicroUsd(this.#total);
  }

  /** The total as a dollar string with six decimals: the integer micro-dollars, written in dollars. */
  totalUsd(): string {
    return microUsdToUsd(this.totalMicroUsd());
  }

  /** Providers in name order. */
  byProviderMicroUsd(): Record<string, bigint> {
    return Object.fromEntries([...this.#byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([p, usd]) => [p, toMicroUsd(usd)]));
  }

  byProviderUsd(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.byProviderMicroUsd()).map(([p, micro]) => [p, microUsdToUsd(micro)]));
  }
}

function toMicroUsd(usd: DecimalValue): bigint {
  return BigInt(usd.times(1_000_000).toFixed(0, D.ROUND_HALF_UP));
}

function microUsdToUsd(micro: bigint): string {
  return minorUnitsToUsd(micro.toString(), 6);
}
