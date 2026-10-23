/**
 * The answer key of an MCP-mode session, taken at the session's own time (D117). The design note to Blockworks says an MCP answer is checked against "a snapshot we take at the same time, with
 * a small tolerance". The day's one snapshot cannot keep that promise: the provider publishes the previous day's figures late, so the same series ended one day later through the MCP at 12:49Z
 * than in the snapshot pulled at 06:19Z (2026-10-20, all 100 series compared), and a session checked against that snapshot fails whatever the model does.
 *
 * So each session gets its own key: a REST pull of exactly what its question needs (never more), taken immediately before the session starts, stored under its own tag beside the day's snapshot and
 * listed, as hashes only, in the day's manifest. The key is the reference solver's answer on THAT data. The day's snapshot is still what the instances are drawn from; it no longer grades anything.
 * The record carries the pull's time and the session's, so the gap between them is always visible; the tolerance is the gates' own.
 *
 * A pull that fails is a service failure and aborts before the model is called, so no money is spent on a session that could not be graded.
 */
import { addDays, monthsBefore } from "../data-desk/dates.js";
import { DataDeskError, type DataDesk } from "../data-desk/desk.js";
import { catalog } from "../data-desk/queries.js";
import { batches, idsOfRows } from "../data-desk/snapshot-plan.js";
import type { SnapshotStore } from "../data-desk/snapshots.js";
import type { Query } from "../data-desk/types.js";
import { daySha256 } from "../runner/run-day.js";
import { loadDay, type DayData } from "../tasks/day-data.js";
import type { Instance } from "../tasks/instances.js";
import { MAX_SERIES_PER_CALL } from "../data-desk/queries.js";

export interface SessionKey {
  /** what the pull held, read as a day: the reference solver runs on it */
  day: DayData;
  tag: string;
  /** a hash over the pull's bodies, as the day's own is (`daySha256`) */
  sha256: string;
  /** when the last of the pull's requests answered */
  pulledAt: string;
  /** requests this pull sent (a response already stored for the tag sends none) */
  requests: number;
}

/** The REST pull for a session's key could not be completed. Only the step's name and the error's class are kept. */
export class KeyPullFailed extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown,
  ) {
    super(
      `the answer-key pull failed at "${step}" (${cause instanceof DataDeskError ? `status ${cause.status ?? "?"}` : cause instanceof Error ? cause.name : "error"})`,
    );
    this.name = "KeyPullFailed";
  }
}

/** The question cannot be keyed from the data pulled (a gap in a quarter, fewer than five rows): not a result about a model, and not retryable by it. */
export class KeyUnavailable extends Error {
  constructor(readonly instance: string) {
    super(`the answer-key pull for ${instance} cannot answer its question`);
    this.name = "KeyUnavailable";
  }
}

/**
 * One tag per ATTEMPT at a session: lowercase letters, digits and hyphens, ending in the second the attempt started. A tag reused across attempts would find the key an earlier, interrupted
 * attempt had pulled and use it as it was (a stored response is not pulled again), so a resumed session would be graded against a key taken long before it (seen 2026-10-23: 54 minutes).
 */
export const keyTagFor = (instance: Pick<Instance, "id">, modelId: string, at: Date): string =>
  `key-${instance.id}-${modelId}-t${Math.floor(at.getTime() / 1000)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");

export interface PullKeyInput {
  desk: DataDesk;
  store: SnapshotStore;
  instance: Instance;
  window: string;
  tag: string;
  now?: () => Date;
}

/** Pulls what the instance's question needs, under its own tag, and reads it as a day. */
export async function pullSessionKey(input: PullKeyInput): Promise<SessionKey> {
  const { desk, store, instance, window, tag } = input;
  let requests = 0;
  const pull = async (step: string, q: Query) => {
    try {
      const s = await desk.pull(q, { window, tag });
      if (!s.fromStore) requests += 1;
      return s;
    } catch (e) {
      throw new KeyPullFailed(step, e);
    }
  };

  switch (instance.task) {
    case "CR-VS": {
      // every venue's volume over the question's months, as the daily plan's CR-VS pull but for those months only
      const n = instance.reference.months.length;
      const start = monthsBefore(instance.params.endMonth, n);
      const venues = idsOfRows((await pull("perp venues", catalog.perpVenues())).json);
      for (const [i, b] of batches(venues, MAX_SERIES_PER_CALL).entries())
        await pull(
          `perp volume batch ${i + 1}`,
          catalog.perpVolume(b, start, instance.params.endMonth),
        );
      break;
    }
    case "CR-PL": {
      const { protocolId, start, end } = instance.params;
      await pull("lending financials", catalog.lendingFinancials([protocolId], start, end));
      break;
    }
    case "CR-SM": {
      const start90 = addDays(window, -90);
      if (instance.params.dimension === "chain") {
        const chains = idsOfRows(
          (await pull("stablecoin chains", catalog.stablecoinChains())).json,
        );
        for (const [i, b] of batches(chains, MAX_SERIES_PER_CALL).entries())
          await pull(
            `stablecoins by chain batch ${i + 1}`,
            catalog.stablecoinsByChain(b, start90, addDays(window, 1)),
          );
      } else {
        const issuers = idsOfRows(
          (await pull("stablecoin issuers", catalog.stablecoinIssuers())).json,
        );
        for (const [i, b] of batches(issuers, MAX_SERIES_PER_CALL).entries())
          await pull(
            `stablecoins by issuer batch ${i + 1}`,
            catalog.stablecoinsByIssuer(b, start90, addDays(window, 1)),
          );
      }
      break;
    }
    case "CR-UO":
      throw new KeyUnavailable(instance.id); // MCP mode does not run CR-UO (D116)
  }

  const held = store.list(window, tag);
  const pulledAt =
    held
      .map((h) => h.meta.fetchedAt)
      .sort()
      .at(-1) ?? (input.now ?? (() => new Date()))().toISOString();
  return {
    day: loadDay(store, window, tag),
    tag,
    sha256: daySha256(store, window, tag),
    pulledAt,
    requests,
  };
}
