/**
 * Tagging agents' reasoning (D107): draw a blind sample into a local page, read the person's tags back, and measure how far the keyword rules agree with them. Everything stays in the private
 * directory; nothing is published, uploaded or committed. Spends nothing, calls nothing, reads no key.
 *
 *   draw   --scheme research --windows 2026-10-18,2026-10-19 [--n 40] [--practice]   writes page.html: open it from disk in a browser
 *   import --dir <sample dir> --file <downloaded tags .json>                        checks the file against its sample, keeps it
 *   agree  --dir <sample dir>                                                       rules against the person, then tags by model (opens the key)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agreementMarkdown, agreementReport } from "../reasoning/agreement.js";
import { drawPassageSample, type KeyEntry, type TagItem } from "../reasoning/draw.js";
import { fileSessionLoader } from "../reasoning/overview.js";
import { passagesFromRecords } from "../reasoning/passages.js";
import { codeResearch, researchRulesFingerprint } from "../reasoning/research-codes.js";
import { SCHEMES, type TagScheme } from "../reasoning/schemes.js";
import { renderTagPage } from "../reasoning/tag-page.js";
import { readTagsFile, type HumanTag } from "../reasoning/tagging-store.js";
import { assertInPrivate, privatePath } from "../paths.js";
import { FileRecordStore } from "../runner/records.js";

const [command, ...rest] = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
// every file this tool writes goes through here, and none leaves the private directory: reasoning text can restate licensed data
const write = (file: string, text: string): void =>
  writeFileSync(assertInPrivate(file), text, { mode: 0o600 });
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf-8")) as T;

interface SampleFiles {
  scheme: TagScheme;
  items: TagItem[];
  sampleSha256: string;
  dir: string;
}
function openSample(): SampleFiles {
  const given = opt("dir") ?? fail("give --dir <the sample directory the draw printed>");
  let dir = given;
  try {
    dir = assertInPrivate(given);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (!existsSync(join(dir, "items.json"))) fail(`no sample in ${dir}`);
  const meta = readJson<{ scheme: TagScheme["id"]; items: TagItem[]; sampleSha256: string }>(
    join(dir, "items.json"),
  );
  return { scheme: SCHEMES[meta.scheme], items: meta.items, sampleSha256: meta.sampleSha256, dir };
}

/** Where a Windows browser can find a WSL path. */
function windowsPath(p: string): string {
  const distro = process.env.WSL_DISTRO_NAME;
  return distro === undefined ? p : `\\\\wsl.localhost\\${distro}${p.replace(/\//g, "\\")}`;
}

if (command === "draw") {
  const scheme = SCHEMES[(opt("scheme") ?? "research") as TagScheme["id"]];
  if (scheme === undefined) fail("--scheme is research or payment");
  if (scheme.id === "payment")
    fail(
      "no payment-reasoning source is wired yet: the agent economy (Part 5) is not built, so there is nothing to draw",
    );
  const windows = (opt("windows") ?? fail("give --windows 2026-10-18,2026-10-19"))
    .split(",")
    .sort();
  const practice = rest.includes("--practice");
  const n = Number(opt("n") ?? (practice ? 8 : 40));
  const store = new FileRecordStore();
  const passages = windows.flatMap((w) =>
    passagesFromRecords(store.forWindow(w), fileSessionLoader()),
  );
  const mode = practice ? "practice" : "real";
  const drawn = drawPassageSample(
    passages,
    n,
    `${scheme.id}:${mode}:${windows.join(",")}`,
    practice ? "p" : "t",
  );
  const dir = privatePath("cr", "tagging", `${scheme.id}-${mode}-${windows.join("_")}`);
  if (existsSync(join(dir, "items.json")))
    fail(`a ${mode} sample for these windows already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  write(
    join(dir, "items.json"),
    `${JSON.stringify({ scheme: scheme.id, mode, sampleSha256: drawn.sampleSha256, items: drawn.items }, null, 2)}\n`,
  );
  write(join(dir, "sample-key.json"), `${JSON.stringify(drawn.key, null, 2)}\n`);
  write(
    join(dir, "meta.json"),
    `${JSON.stringify({ windows, drawn: n, eligible: drawn.eligible, rulesFingerprint: researchRulesFingerprint(), at: new Date().toISOString() }, null, 2)}\n`,
  );
  write(
    join(dir, "page.html"),
    renderTagPage({ scheme, mode, items: drawn.items, sampleSha256: drawn.sampleSha256 }),
  );
  console.log(
    `${n} of ${drawn.eligible} passages drawn (${mode}). The key is in ${join(dir, "sample-key.json")}: do not open it until your tags are in.`,
  );
  console.log(`Open this file in a browser:\n  ${windowsPath(join(dir, "page.html"))}`);
} else if (command === "import") {
  const s = openSample();
  const file = opt("file") ?? fail("give --file <the downloaded tags .json>");
  const read = readTagsFile(readJson<unknown>(file), s.scheme, s.items, s.sampleSha256);
  if (read.problems.length > 0) fail(`refused:\n  ${read.problems.join("\n  ")}`);
  if (existsSync(join(s.dir, "tags.json"))) fail("tags are already imported for this sample");
  write(
    join(s.dir, "tags.json"),
    `${JSON.stringify({ importedAt: new Date().toISOString(), tags: read.tags }, null, 2)}\n`,
  );
  console.log(`${read.tags.length} tags imported.`);
} else if (command === "agree") {
  const s = openSample();
  if (s.scheme.id !== "research")
    fail("only the research scheme has keyword rules here; the payment scheme's are the lab's");
  if (!existsSync(join(s.dir, "tags.json"))) fail("import the tags first");
  const tags = readJson<{ tags: HumanTag[] }>(join(s.dir, "tags.json")).tags;
  const tagged = s.items.map((it) => {
    const h = tags.find((t) => t.id === it.id) as HumanTag;
    return { id: it.id, human: { ids: h.ids, flag: h.flag }, rules: codeResearch(it.text) };
  });
  const report = agreementReport(s.scheme, tagged);
  let md = agreementMarkdown(s.scheme, report, {
    fingerprint: researchRulesFingerprint(),
    sampleSha256: s.sampleSha256,
  });
  // only now is the key opened: what the people-tagged categories look like for each model
  const key = readJson<Record<string, KeyEntry>>(join(s.dir, "sample-key.json"));
  const models = [...new Set(Object.values(key).map((k) => k.model))].sort();
  md += `## Categories the person tagged, by model\n\n| category | ${models.join(" | ")} |\n|---|${models.map(() => "---").join("|")}|\n`;
  for (const c of s.scheme.categories)
    md += `| ${c.id} | ${models.map((m) => tags.filter((t) => key[t.id]?.model === m && t.ids.includes(c.id)).length).join(" | ")} |\n`;
  md += `| (passages) | ${models.map((m) => Object.values(key).filter((k) => k.model === m).length).join(" | ")} |\n`;
  write(join(s.dir, "agreement.md"), md);
  console.log(
    `exact match on ${report.exactMatch} of ${report.n}; report written (private): ${join(s.dir, "agreement.md")}`,
  );
} else fail("commands: draw, import, agree");
