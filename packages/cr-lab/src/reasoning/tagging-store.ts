/**
 * Reading a person's tags back (D107). The page's downloaded file is checked against the sample it was made on: same scheme, same sample hash, every passage tagged once, every category one the
 * scheme has. Tags that break the exclusivity rules are KEPT as recorded and reported (D69: a clash is recorded, not corrected); anything else wrong refuses the file, so a half-done or
 * mismatched file is never mistaken for a finished round.
 */
import type { TagItem } from "./draw.js";
import type { TagScheme } from "./schemes.js";
import { isAnswered } from "./schemes.js";

export interface HumanTag {
  id: string;
  ids: string[];
  flag: boolean;
}

export interface ReadTags {
  tags: HumanTag[];
  /** reasons the file was refused; empty when it was accepted */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function readTagsFile(
  raw: unknown,
  scheme: TagScheme,
  items: readonly TagItem[],
  sampleSha256: string,
): ReadTags {
  const problems: string[] = [];
  if (!isRecord(raw)) return { tags: [], problems: ["the file is not a tags file"] };
  if (raw.scheme !== scheme.id)
    problems.push(`the tags are for the "${String(raw.scheme)}" scheme, not "${scheme.id}"`);
  if (raw.sample_sha256 !== sampleSha256) problems.push("the tags were made on a different sample");
  const list = Array.isArray(raw.tags) ? raw.tags : [];
  if (!Array.isArray(raw.tags)) problems.push("the file has no tags");
  const valid = new Set(scheme.categories.map((c) => c.id));
  const tags: HumanTag[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (!isRecord(t) || typeof t.id !== "string") {
      problems.push("a tag has no id");
      continue;
    }
    if (seen.has(t.id)) problems.push(`${t.id} is tagged twice`);
    seen.add(t.id);
    if (!items.some((i) => i.id === t.id)) problems.push(`${t.id} is not in the sample`);
    const ids = Array.isArray(t.categories)
      ? t.categories.filter((c): c is string => typeof c === "string")
      : [];
    for (const c of ids) if (!valid.has(c)) problems.push(`${t.id} has an unknown category "${c}"`);
    const flag = t.flag === true;
    if (flag && scheme.flag === undefined)
      problems.push(`${t.id} ticks a flag this scheme does not have`);
    if (!isAnswered({ ids, flag })) problems.push(`${t.id} has no box ticked`);
    tags.push({ id: t.id, ids, flag });
  }
  for (const i of items) if (!seen.has(i.id)) problems.push(`${i.id} was not tagged`);
  return { tags, problems };
}
