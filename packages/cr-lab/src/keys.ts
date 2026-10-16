/**
 * The trial's keys, and nothing else (D72). Every trial key has its own `CR_` name in `.env`, separate from the daily print's own provider keys, so each provider's
 * usage page shows exactly what the trial spent and a trial bug can neither spend the print's credit nor read its keys. This module reads only `CR_` names and **never
 * falls back to the print's key** when a trial key is unset: it throws, naming the variable and never its value.
 *
 * Two promises are enforced by tests (`isolation.test.ts`): trial code never names any of the print's key variables, and print-side code and workflows never name a
 * `CR_` variable. A key is held as a `Secret`, which prints, serialises and inspects as a placeholder, so a stray log line or JSON dump cannot leak it; `reveal()` is
 * explicit.
 */
import { inspect } from "node:util";

export type Provider = "anthropic" | "openai" | "google" | "xai" | "openrouter";
export const PROVIDERS: readonly Provider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "openrouter",
];

/** The `.env` name of each provider's trial key. */
export const TRIAL_KEY_NAMES: Readonly<Record<Provider, string>> = {
  anthropic: "CR_ANTHROPIC_API_KEY",
  openai: "CR_OPENAI_API_KEY",
  google: "CR_GOOGLE_API_KEY",
  xai: "CR_XAI_API_KEY",
  openrouter: "CR_OPENROUTER_API_KEY",
};

/** The Blockworks key. Only the data desk reads it: no model, agent or other package ever sees it (a test keeps every other file from naming it). */
export const BLOCKWORKS_KEY_NAME = "CR_BLOCKWORKS_API_KEY";

type Env = Readonly<Record<string, string | undefined>>;

/** A secret value that cannot leak through string conversion, JSON or `util.inspect`. */
export class Secret {
  readonly #value: string;
  readonly name: string;

  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
  }

  /** The value itself, for the one place that must send it (a provider adapter's request, the data desk's request). */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[redacted ${this.name}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export class MissingKeyError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is not set in .env (the trial never falls back to the daily print's key)`);
    this.name = "MissingKeyError";
  }
}

function read(env: Env, name: string): Secret | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : new Secret(name, value);
}

/** The trial's key for `provider`. Throws `MissingKeyError` (naming the variable only) when it is unset or empty. */
export function trialKey(provider: Provider, env: Env = process.env): Secret {
  const key = read(env, TRIAL_KEY_NAMES[provider]);
  if (key === undefined) throw new MissingKeyError(TRIAL_KEY_NAMES[provider]);
  return key;
}

/** The providers whose trial key is set, in `PROVIDERS` order. */
export function providersWithKeys(env: Env = process.env): Provider[] {
  return PROVIDERS.filter((p) => read(env, TRIAL_KEY_NAMES[p]) !== undefined);
}

/** The `.env` names of the trial model keys that are unset or empty (the Blockworks key is separate). */
export function missingTrialKeys(env: Env = process.env): string[] {
  return PROVIDERS.filter((p) => read(env, TRIAL_KEY_NAMES[p]) === undefined).map(
    (p) => TRIAL_KEY_NAMES[p],
  );
}

/** The Blockworks key, for the data desk only. */
export function blockworksKey(env: Env = process.env): Secret {
  const key = read(env, BLOCKWORKS_KEY_NAME);
  if (key === undefined) throw new MissingKeyError(BLOCKWORKS_KEY_NAME);
  return key;
}

/**
 * `text` with the value of every `CR_` variable in `env` replaced by a placeholder, for an error message or a log line that may have picked a key up on its way
 * (a provider echoing a request, a URL with a key in it). Values under 8 characters are left alone: too short to be a key, and replacing them would mangle text.
 */
export function redactTrialSecrets(text: string, env: Env = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    const v = value?.trim();
    if (!name.startsWith("CR_") || v === undefined || v.length < 8) continue;
    out = out.split(v).join(`[redacted ${name}]`);
  }
  return out;
}
