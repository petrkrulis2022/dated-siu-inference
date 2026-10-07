import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnSource } from "../lab/decisions.js";

/** The recorder folder's turns, by agent: each `messages/<agent>/<n>.json` holds the prompt and the raw reply of turn n. */
export function turnsFromRecorder(runDir: string): Record<string, TurnSource[]> {
  const out: Record<string, TurnSource[]> = {};
  const root = join(runDir, "messages");
  for (const agent of readdirSync(root)) {
    out[agent] = readdirSync(join(root, agent))
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => {
        const j = JSON.parse(readFileSync(join(root, agent, f), "utf-8")) as { prompt?: string; rawText?: string };
        return { turn: Number(f.replace(".json", "")), ...(j.rawText !== undefined ? { rawText: j.rawText } : {}), ...(j.prompt !== undefined ? { promptText: j.prompt } : {}) };
      })
      .sort((a, b) => a.turn - b.turn);
  }
  return out;
}
