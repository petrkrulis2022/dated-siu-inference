import type { AgentRunRecord } from "../types/generated/agent-run-record.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/agent-run-record.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<AgentRunRecord>(schema);

export function validateAgentRunRecord(data: unknown): ValidationResult<AgentRunRecord> {
  if (validateFn(data)) {
    return { valid: true, data: data as AgentRunRecord };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
