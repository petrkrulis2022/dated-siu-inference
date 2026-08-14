import { fetchAkashGpuPrices } from "../sources/akash.js";
import { fetchVastAiOffers } from "../sources/vastai.js";
import { decimalDivide, decimalLessThan, jsonNumberToDecimalString } from "../decimal.js";

/**
 * Floor-column inputs, not the floor itself — build1-spec.md §5's actual floor also needs
 * measured GPU-seconds-per-basket from the harness, which doesn't exist yet. This snapshot
 * just captures the rental-rate side: "auction-cleared compute-exchange prints" (Akash) and
 * "Vast.ai public listings", both freely usable, neither paid nor licensed.
 */
export interface GpuRateEntry {
  source: "akash" | "vastai";
  gpu_model: string;
  rate_usd_per_hour: string;
  sample_size: number;
}

export interface GpuRateSnapshot {
  snapshot_id: string;
  timestamp: string;
  reference_gpu: string;
  entries: GpuRateEntry[];
}

export interface ReferenceGpu {
  /** Must match Akash's gpu-prices "model" field (lowercase), e.g. "h100". */
  akashModel: string;
  /** Must match Vast.ai's "gpu_name" field, e.g. "H100 SXM". */
  vastaiGpuName: string;
  /** Human-readable label for the snapshot. */
  label: string;
}

export async function buildGpuRateSnapshot(
  referenceGpu: ReferenceGpu,
  snapshotId: string,
  timestamp: string,
): Promise<GpuRateSnapshot> {
  const entries: GpuRateEntry[] = [];

  const akashPrices = await fetchAkashGpuPrices();
  const akashMatch = akashPrices.find(
    (p) => p.model.toLowerCase() === referenceGpu.akashModel.toLowerCase(),
  );
  if (akashMatch) {
    entries.push({
      source: "akash",
      gpu_model: `${akashMatch.vendor} ${akashMatch.model} ${akashMatch.ram} ${akashMatch.interface}`,
      // weightedAverage, not a plain mean — it's Akash's own server-computed figure, not
      // something derived here via float arithmetic.
      rate_usd_per_hour: jsonNumberToDecimalString(akashMatch.price.weightedAverage),
      sample_size: akashMatch.providerAvailability.total,
    });
  }

  const vastaiOffers = await fetchVastAiOffers({ gpu_name: referenceGpu.vastaiGpuName, limit: 20 });
  const rentable = vastaiOffers.filter((o) => o.rentable);
  if (rentable.length > 0) {
    let cheapest = decimalDivide(rentable[0].dph_total, rentable[0].num_gpus || 1);
    for (const offer of rentable.slice(1)) {
      const perGpu = decimalDivide(offer.dph_total, offer.num_gpus || 1);
      if (decimalLessThan(perGpu, cheapest)) {
        cheapest = perGpu;
      }
    }
    entries.push({
      source: "vastai",
      gpu_model: referenceGpu.vastaiGpuName,
      // The floor is the cheapest currently-rentable matching offer, not an average —
      // averaging several JSON floats is exactly the money-math-in-floats CLAUDE.md forbids,
      // and "cheapest observed" is what "floor" means anyway.
      rate_usd_per_hour: cheapest,
      sample_size: rentable.length,
    });
  }

  return {
    snapshot_id: snapshotId,
    timestamp,
    reference_gpu: referenceGpu.label,
    entries,
  };
}
