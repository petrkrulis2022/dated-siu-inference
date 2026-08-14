const VASTAI_BUNDLES_URL = "https://console.vast.ai/api/v0/bundles/";

export interface VastAiOffer {
  gpu_name: string;
  num_gpus: number;
  dph_total: number;
  rentable: boolean;
}

export interface VastAiQuery {
  gpu_name: string;
  limit?: number;
}

/** Vast.ai's public marketplace listings. No API key required for read-only search. */
export async function fetchVastAiOffers(query: VastAiQuery): Promise<VastAiOffer[]> {
  const q = {
    gpu_name: { eq: query.gpu_name },
    rentable: { eq: true },
    order: [["dph_total", "asc"]],
    limit: query.limit ?? 10,
  };
  const url = `${VASTAI_BUNDLES_URL}?q=${encodeURIComponent(JSON.stringify(q))}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Vast.ai bundles fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { offers: VastAiOffer[] };
  return body.offers;
}
