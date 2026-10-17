/** Grades one reply against one instance: parse, then the task's gate. Objective only (invariant 6): no judge model is ever consulted. */
import { gatePL, gateSM, gateUO, gateVS, parseAnswer, type Verdict } from "../tasks/gates.js";
import type { Instance } from "../tasks/instances.js";
import type { PLReference, SMReference, UOReference, VSReference } from "../tasks/solve.js";

export function gradeAnswer(instance: Instance, text: string): Verdict {
  const parsed = parseAnswer(text);
  if (!parsed.ok) return { passed: false, failures: [parsed.failure], fenced: false };
  switch (instance.task) {
    case "CR-VS":
      return gateVS(parsed.value, instance.reference as VSReference, parsed.fenced);
    case "CR-PL":
      return gatePL(parsed.value, instance.reference as PLReference, parsed.fenced);
    case "CR-UO":
      return gateUO(parsed.value, instance.reference as UOReference, parsed.fenced);
    case "CR-SM":
      return gateSM(parsed.value, instance.reference as SMReference, parsed.fenced);
  }
}
