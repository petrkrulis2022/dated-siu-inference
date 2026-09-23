import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { TOOLS, type ToolName } from "../tools/index.js";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));

export interface SkillScoring {
  metrics: string[];
}

/**
 * Spec §12.3: "/skills/<name>/ SKILL.md tools.yaml scoring.yaml" — the file-based registry
 * replacing this package's old plain-TS skill constants. `promptTemplate` may still contain
 * `{placeholder}` tokens (issue-work-claims does, per spec §8.2's own worked example) —
 * `renderTemplate` below fills them from real data; nothing here invents a default.
 */
export interface Skill {
  name: string;
  promptTemplate: string;
  allowedTools: readonly ToolName[];
  scoring: SkillScoring;
}

function assertKnownTools(value: unknown, skillName: string): ToolName[] {
  if (!Array.isArray(value)) {
    throw new Error(`skills/${skillName}/tools.yaml: expected a "tools" array`);
  }
  for (const name of value) {
    if (typeof name !== "string" || !(name in TOOLS)) {
      throw new Error(`skills/${skillName}/tools.yaml: "${String(name)}" is not a real tool name (see tools/index.ts)`);
    }
  }
  return value as ToolName[];
}

/**
 * Spec §12.3: "the runtime denies any call outside that list" — `loadSkill(name).allowedTools`
 * is the real source of truth `Runner`'s enforcement (runner.ts) and `loop/prompt.ts`'s prompt
 * text should both be built from, so the two can never drift into showing a model one tool list
 * while enforcing a different one.
 */
export function loadSkill(name: string): Skill {
  const dir = join(SKILLS_DIR, name);
  const promptTemplate = readFileSync(join(dir, "SKILL.md"), "utf-8");
  const toolsFile = parse(readFileSync(join(dir, "tools.yaml"), "utf-8")) as { tools?: unknown };
  const allowedTools = assertKnownTools(toolsFile.tools, name);
  const scoring = parse(readFileSync(join(dir, "scoring.yaml"), "utf-8")) as SkillScoring;
  return { name, promptTemplate, allowedTools, scoring };
}

/** Fills a skill's `{placeholder}` tokens from real data — never a default value, per this
 * repo's own rule against invented numbers in anything a model or operator will read. */
export function renderTemplate(template: string, params: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(params)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}
