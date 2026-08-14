const AKASH_GPU_PRICES_URL = "https://console-api.akash.network/v1/gpu-prices";

export interface AkashGpuPriceEntry {
  vendor: string;
  model: string;
  ram: string;
  interface: string;
  providerAvailability: {
    total: number;
    available: number;
  };
  price: {
    currency: string;
    min: number;
    max: number;
    avg: number;
    weightedAverage: number;
    med: number;
  };
}

/** Akash's public, on-chain-auction-cleared GPU rental rates. No API key required. */
export async function fetchAkashGpuPrices(): Promise<AkashGpuPriceEntry[]> {
  const res = await fetch(AKASH_GPU_PRICES_URL);
  if (!res.ok) {
    throw new Error(`Akash gpu-prices fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { models: AkashGpuPriceEntry[] };
  return body.models;
}
