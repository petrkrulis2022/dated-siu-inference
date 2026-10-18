/**
 * How far the keyword rules agree with a person reading the same passages (D107). Reported per category, never averaged away: for each category, how many passages the person and the rules both
 * put in it, only the person, only the rules, neither; the share on which they agree; and Cohen's kappa for that category, which discounts the agreement a rare category gets for free.
 * Tags that break the exclusivity rules (a stand-alone category ticked with others) are listed as recorded and are not corrected, as the lab did (D69).
 */
import type { TagScheme } from "./schemes.js";

export interface TaggedPassage {
  id: string;
  /** the person's boxes */
  human: { ids: string[]; flag: boolean };
  /** the rules' codes for the same text */
  rules: string[];
}

export interface CategoryAgreement {
  id: string;
  both: number;
  humanOnly: number;
  rulesOnly: number;
  neither: number;
  /** share of passages on which person and rules agree about this category, 0 to 1 */
  agree: number;
  /** Cohen's kappa for this category; null where it cannot be computed (chance agreement is total) */
  kappa: number | null;
}

export interface AgreementReport {
  n: number;
  categories: CategoryAgreement[];
  /** passages whose set of categories is identical for person and rules */
  exactMatch: number;
  /** ids whose tags break the exclusivity rules, as recorded */
  clashes: string[];
}

export function agreementReport(
  scheme: TagScheme,
  tagged: readonly TaggedPassage[],
): AgreementReport {
  const n = tagged.length;
  const categories = scheme.categories.map((c): CategoryAgreement => {
    let both = 0;
    let humanOnly = 0;
    let rulesOnly = 0;
    for (const t of tagged) {
      const h = t.human.ids.includes(c.id);
      const r = t.rules.includes(c.id);
      if (h && r) both++;
      else if (h) humanOnly++;
      else if (r) rulesOnly++;
    }
    const neither = n - both - humanOnly - rulesOnly;
    const po = n === 0 ? 0 : (both + neither) / n;
    const ph = n === 0 ? 0 : (both + humanOnly) / n;
    const pr = n === 0 ? 0 : (both + rulesOnly) / n;
    const pe = ph * pr + (1 - ph) * (1 - pr);
    return {
      id: c.id,
      both,
      humanOnly,
      rulesOnly,
      neither,
      agree: po,
      kappa: pe === 1 ? null : (po - pe) / (1 - pe),
    };
  });
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));
  const exactMatch = tagged.filter((t) => same(t.human.ids, t.rules)).length;
  const clashes = tagged
    .filter(
      (t) =>
        t.human.ids.some((id) => scheme.exclusive.includes(id)) &&
        (t.human.ids.length > 1 || t.human.flag),
    )
    .map((t) => t.id);
  return { n, categories, exactMatch, clashes };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const k = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));

export function agreementMarkdown(
  scheme: TagScheme,
  report: AgreementReport,
  meta: { fingerprint: string; sampleSha256: string },
): string {
  const lines = [
    `# Agreement of the keyword rules with a person: ${scheme.title}`,
    "",
    `${report.n} passages tagged blind. Rules fingerprint ${meta.fingerprint}. Sample ${meta.sampleSha256}.`,
    `The person and the rules gave exactly the same set of categories on ${report.exactMatch} of ${report.n}.`,
    "",
    "| category | both | person only | rules only | neither | agree | kappa |",
    "|---|---|---|---|---|---|---|",
    ...report.categories.map(
      (c) =>
        `| ${c.id} | ${c.both} | ${c.humanOnly} | ${c.rulesOnly} | ${c.neither} | ${pct(c.agree)} | ${k(c.kappa)} |`,
    ),
    "",
    "Kappa discounts the agreement a rare category gets for free: a category on which agree is high and kappa is near zero is one the rules cannot find. Low agreement on a pair of overlapping categories is read as the overlap, not as an error.",
    "",
  ];
  if (report.clashes.length > 0)
    lines.push(
      `Tags that break the exclusivity rules, reported as recorded and not corrected: ${report.clashes.join(", ")}.`,
      "",
    );
  return `${lines.join("\n")}\n`;
}
