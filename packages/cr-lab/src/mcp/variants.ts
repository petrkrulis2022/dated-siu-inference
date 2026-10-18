/**
 * MCP mode's own versions of a question (D105). Snapshot mode keeps the full year for the volume question, because the data is handed over. In MCP mode the model must read it through the
 * tools, and on the live data (31 perp venues, about 35 thousand tokens for ten venues over twelve months, and the server refuses more than 5,000 points a call) reading every venue for
 * twelve months is about 109 thousand tokens of tool results, which across a session's turns reaches the $1 session cap. So in MCP mode the volume question covers the last three complete
 * months: about 27 thousand tokens for every venue. The question is otherwise the same, its key is computed the same way, and the session record names the variant.
 */
import type { DayData } from "../tasks/day-data.js";
import type { Instance } from "../tasks/instances.js";
import { solveVS } from "../tasks/solve.js";

export const MCP_VS_MONTHS = 3;

/** The instance as MCP mode asks it, and the variant's name if it differs from snapshot mode's; undefined if the day cannot answer the MCP version. */
export function toMcpInstance(
  instance: Instance,
  day: DayData,
): { instance: Instance; variant?: string } | undefined {
  if (instance.task !== "CR-VS") return { instance };
  const reference = solveVS(day, instance.params.endMonth, MCP_VS_MONTHS);
  if (reference === undefined) return undefined;
  return {
    instance: {
      ...instance,
      params: { endMonth: instance.params.endMonth, months: MCP_VS_MONTHS },
      reference,
    },
    variant: `vs-${MCP_VS_MONTHS}-months`,
  };
}
