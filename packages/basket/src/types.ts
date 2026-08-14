export type TaskClass = "T1" | "T2" | "T3";

export interface ExecutionParams {
  temperature: 0;
  max_tokens: number;
  /** Set on T2 — long-context retrieval's cache policy is a stated methodology decision. */
  cache_control?: "disabled";
}

export interface TaskInstance<Expected = unknown> {
  task_class: TaskClass;
  instance_id: string;
  seed: number;
  prompt: string;
  params: ExecutionParams;
  /** Grading-only data — never part of the prompt sent to the model. */
  expected: Expected;
}

export interface GradeResult {
  passed: boolean;
  /** Human-readable explanation, mainly useful on failure. */
  reason?: string;
}

export type Grader<Expected = unknown> = (
  instance: TaskInstance<Expected>,
  rawResponse: string,
) => Promise<GradeResult>;
