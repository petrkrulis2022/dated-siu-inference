export { Runner, type RunnerOptions } from "./runner.js";
export type { RunnerDeps, ToolContext } from "./deps.js";

export {
  AGENT_IDS,
  erc8004IdFor,
  buildAgentRosterResolver,
  type AgentId,
} from "./identity/resolve.js";

export { BudgetCeiling, CeilingExceededError, type BudgetLimits } from "./budget/ceiling.js";

export { FrictionLogWriter, type FrictionLogEntry } from "./friction/log.js";

export { DualRenderer, type DualRenderArm, type DualRenderRecord } from "./context/dual-render.js";
export {
  assembleContext,
  serializeContext,
  type AgentContext,
  type ToolCallRecord,
} from "./context/assemble.js";

export { TOOLS, type ToolDefinition, type ToolName } from "./tools/index.js";

export { WORK_CLAIM_ABI, CAPACITY_BOND_ABI, USDC_BALANCE_ABI } from "./chain/abi.js";
export type { ChainReader } from "./chain/reader.js";
export { ViemChainReader } from "./chain/reader.js";
export { loadGateMarketDeployment, type GateMarketDeployment } from "./chain/deployment.js";

export { CANONICAL_ASSET_DESCRIPTION } from "./skills/asset-description.js";
export { renderIssueWorkClaims, type IssueWorkClaimsParams } from "./skills/issue-work-claims.js";
export { SUBCONTRACT_AND_SETTLE } from "./skills/subcontract-and-settle.js";
export { QUOTE_AND_DELIVER } from "./skills/quote-and-deliver.js";

export {
  buildCommonPack,
  type CommonPackParams,
  type ClassInfo,
  type ClassPrint,
} from "./pack/build.js";
export { TOOL_DESCRIPTIONS, formatToolList } from "./pack/tool-descriptions.js";
export {
  validateAgentContext,
  ContextValidationError,
  type ValidationFailureKind,
} from "./pack/validate.js";
