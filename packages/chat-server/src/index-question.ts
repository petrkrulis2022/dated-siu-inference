/**
 * A deliberately non-LLM path for the most common question this widget gets: "what's the price
 * right now." Once the daily budget is spent, no LLM call happens for the rest of the day — but
 * get_index itself is still free and still real, so a plain templated reply built directly from
 * its output stays available. This is not a fallback that guesses; it either states a real,
 * live-fetched number or says the lookup failed — never a stand-in value.
 */

const INDEX_QUESTION = /\b(price|index|siu|print|value|rate|worth|cost)\b/i;

export function looksLikeIndexQuestion(message: string): boolean {
  return INDEX_QUESTION.test(message);
}

interface IndexLike {
  version?: unknown;
  date?: unknown;
  dated_siu?: unknown;
  floor?: { value?: unknown } | null;
  market_spread?: unknown;
}

/** Builds a plain-text summary straight from a real get_index response — every field either
 * comes verbatim off the print or is omitted, never invented. */
export function summarizeIndexWithoutLlm(index: unknown): string {
  const p = index as IndexLike;
  const version = typeof p.version === "string" ? p.version : "unknown basket version";
  const date = typeof p.date === "string" ? p.date : "unknown date";
  const datedSiu = typeof p.dated_siu === "string" ? p.dated_siu : null;

  if (!datedSiu) {
    return "The current print didn't come back in the expected shape — see the live print at prints.touchstoneassay.com instead of a guess here.";
  }

  let text = `Dated SIU for ${date} (basket ${version}): $${datedSiu} per SIU.`;
  const floorValue = p.floor && typeof p.floor.value === "string" ? p.floor.value : null;
  if (floorValue) text += ` Floor (hardware cost of the basket): $${floorValue}.`;
  if (typeof p.market_spread === "string") text += ` Market spread: ${p.market_spread}.`;
  text += " Full print: prints.touchstoneassay.com.";
  return text;
}
