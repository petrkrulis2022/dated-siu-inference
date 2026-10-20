/**
 * Keeps a service failure out of the results (D116). In a scheduled MCP-mode day a tool call can fail because the provider refused or lost the call (a 429 that outlasted the governor's
 * retries, a server error, a dropped connection, the day's request limit), not because of anything the model did. The tool loop relays a failed call to the model as an error result, and the
 * model then answers badly, so recording that session would count the provider's outage against the model. This wraps the backend so a session that met such a failure is noticed, and wraps
 * the record store so that session is NOT recorded: the run stops with `McpSessionsAborted`, and the next scheduled run draws the same instance again (a window holds one record per instance
 * and model, and this one was never written). The money the session spent stays in the spend ledger, where it belongs.
 *
 * A refusal about the call itself (an error result from the server: bad arguments, an unknown model) is the model's to handle and is not an incident.
 */
import { DailyRequestLimit, HourlyRequestLimit, RateLimited } from "../data-desk/governor.js";
import type { AnswerRecord, RecordStore } from "../runner/records.js";
import { McpLoginRequired, McpTransportFailure } from "./live-mcp.js";
import type { McpBackend, McpCallResult, McpToolDef } from "./types.js";

export type IncidentKind =
  "rate-limited" | "request-limit" | "login-required" | "transport-failure" | "other";

export interface Incident {
  kind: IncidentKind;
  /** a sanitised line: the error class and, for a limit, which one; never a message from the server */
  detail: string;
}

export function classifyIncident(e: unknown): Incident {
  if (e instanceof McpLoginRequired) return { kind: "login-required", detail: "McpLoginRequired" };
  if (e instanceof RateLimited)
    return { kind: "rate-limited", detail: `RateLimited (${e.status})` };
  if (e instanceof HourlyRequestLimit || e instanceof DailyRequestLimit)
    return { kind: "request-limit", detail: e.name };
  if (e instanceof McpTransportFailure)
    return { kind: "transport-failure", detail: `McpTransportFailure (${e.errorClass})` };
  return { kind: "other", detail: e instanceof Error ? e.name : "UnknownError" };
}

/** The run stopped because a session met a service failure; that session was not recorded. */
export class McpSessionsAborted extends Error {
  constructor(
    readonly incident: Incident,
    readonly instance: string,
    readonly model: string,
  ) {
    super(
      `the session ${instance} / ${model} met a service failure (${incident.detail}) and was not recorded`,
    );
    this.name = "McpSessionsAborted";
  }
}

export class InfraWatchMcp implements McpBackend {
  #incident: Incident | undefined;
  constructor(readonly inner: McpBackend) {}

  get name(): McpBackend["name"] {
    return this.inner.name;
  }

  tools(): Promise<McpToolDef[]> {
    return this.inner.tools();
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    try {
      return await this.inner.call(name, args);
    } catch (e) {
      // the first failure of a session is the one reported; the model is still shown the error, as the loop does for any failed call
      this.#incident ??= classifyIncident(e);
      throw e;
    }
  }

  /** The incident of the session that just ended, if there was one; reading it clears it for the next session. */
  take(): Incident | undefined {
    const i = this.#incident;
    this.#incident = undefined;
    return i;
  }
}

export class AbortOnIncidentStore implements RecordStore {
  constructor(
    private readonly inner: RecordStore,
    private readonly watch: InfraWatchMcp,
  ) {}

  append(rec: AnswerRecord): void {
    const incident = this.watch.take();
    if (incident !== undefined) throw new McpSessionsAborted(incident, rec.instance, rec.model);
    this.inner.append(rec);
  }

  forWindow(window: string): AnswerRecord[] {
    return this.inner.forWindow(window);
  }

  windows(): string[] {
    return this.inner.windows();
  }
}
