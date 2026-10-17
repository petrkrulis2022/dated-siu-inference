/**
 * Turns registry model ids into seats for a run: which trial key pays, what the model costs, and the print's own adapter for it (D83: through the print's existing adapters, never a
 * second client). The key comes only from `trialKey`, i.e. a `CR_` variable with no fallback, and is handed to the adapter explicitly: the harness's own environment key loader (the one that
 * reads the print's variable names) is never called here, and a source-scan test forbids it, so this code cannot pick up the print's keys even by accident.
 */
import { createAdapterFor, type Adapter } from "@touchstone/harness";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import { TRIAL_KEY_NAMES, trialKey, type Provider, type Secret } from "../keys.js";
import { loadRegistryAndPrices, priceFor } from "./prices.js";
import type { Seat } from "./run-answer.js";

/** Registry providers the trial has a key for. */
const TRIAL_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "xai",
  "openrouter",
]);

export class NoTrialKeyForProvider extends Error {
  constructor(
    readonly modelId: string,
    readonly provider: string,
  ) {
    super(
      `model "${modelId}" is served by "${provider}", which has no trial key: the trial can use anthropic, openai, google, xai and openrouter`,
    );
    this.name = "NoTrialKeyForProvider";
  }
}

/** The registry's own sampling for the model: its fixed temperature, or none sent at all where the registry says the provider's default applies. */
function samplingFor(entry: ModelRegistryEntry): Seat["params"] {
  const t = entry.sampling?.temperature;
  return typeof t === "number"
    ? { temperature: t, max_tokens: 4000 }
    : { temperature: 0, max_tokens: 4000, omit_temperature: true };
}

export interface BuildSeatsOptions {
  env?: Readonly<Record<string, string | undefined>>;
  dataRoot?: string;
  /** Replaces the real adapter, for tests and the fixture dry run; the key is still looked up unless `skipKeys` is set. */
  adapterFor?: (entry: ModelRegistryEntry, secret: Secret | undefined) => Adapter;
  /** Do not read any key (fixture runs, whose adapters are stand-ins). */
  skipKeys?: boolean;
}

export function buildSeats(modelIds: readonly string[], opts: BuildSeatsOptions = {}): Seat[] {
  const { registry, snapshot } = loadRegistryAndPrices(opts.dataRoot);
  return modelIds.map((id) => {
    const entry = registry.find((r) => r.id === id);
    if (entry === undefined) throw new Error(`"${id}" is not in the model registry`);
    if (!TRIAL_PROVIDERS.has(entry.provider)) throw new NoTrialKeyForProvider(id, entry.provider);
    const provider = entry.provider as Provider;
    const secret = opts.skipKeys === true ? undefined : trialKey(provider, opts.env);
    const adapter =
      opts.adapterFor !== undefined
        ? opts.adapterFor(entry, secret)
        : createAdapterFor(entry, { [provider]: (secret as Secret).reveal() });
    return {
      modelId: entry.id,
      modelString: entry.model_string,
      provider,
      keyName: TRIAL_KEY_NAMES[provider],
      price: priceFor(entry.id, snapshot),
      adapter,
      params: samplingFor(entry),
      entry: { id: entry.id, provider: entry.provider },
    };
  });
}
