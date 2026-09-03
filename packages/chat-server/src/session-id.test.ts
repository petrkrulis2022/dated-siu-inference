import { describe, expect, it } from "vitest";
import { isValidSessionId } from "./session-id.js";

describe("isValidSessionId", () => {
  it("accepts a crypto.randomUUID()-shaped string", () => {
    expect(isValidSessionId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("'; DROP TABLE conversations; --")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
  });
});
