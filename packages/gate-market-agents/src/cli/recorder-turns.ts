import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnSource } from "../lab/decisions.js";

/**
 * The recorder folder's turns, by agent: each `messages/<agent>/<n>.json` holds the prompt and the raw reply of turn n, and from instrument v8 any reasoning
 * the provider returned and the reasoning tokens billed. It holds no global order of turns, so a rebuilt overview lists them by turn and seat.
 */
export function turnsFromRecorder(runDir: string): Record<string, TurnSource[]> {
  const out: Record<string, TurnSource[]> = {};
  const root = join(runDir, "messages");
  for (const agent of readdirSync(root)) {
    out[agent] = readdirSync(join(root, agent))
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => {
        const j = JSON.parse(readFileSync(join(root, agent, f), "utf-8")) as {
          prompt?: string;
          rawText?: string;
          thinking?: string;
          usage?: { reasoning?: number };
        };
        return {
          turn: Number(f.replace(".json", "")),
          ...(j.rawText !== undefined ? { rawText: j.rawText } : {}),
          ...(j.prompt !== undefined ? { promptText: j.prompt } : {}),
          ...(j.thinking !== undefined ? { thinking: j.thinking } : {}),
          ...(typeof j.usage?.reasoning === "number" ? { usage: { reasoning: j.usage.reasoning } } : {}),
        };
      })
      .sort((a, b) => a.turn - b.turn);
  }
  return out;
}
