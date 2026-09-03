import { describe, expect, it } from "vitest";
import { stripSensitive } from "./pii.js";

describe("stripSensitive", () => {
  it("redacts an email address", () => {
    expect(stripSensitive("contact me at petr@example.com please")).toBe(
      "contact me at [redacted-email] please",
    );
  });

  it("redacts an API-key-shaped string", () => {
    expect(stripSensitive("my key is sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(
      "my key is [redacted-key]",
    );
  });

  it("redacts a 0x-prefixed hex string (wallet address, tx hash, private key)", () => {
    expect(stripSensitive("send to 0x22e2F3427FfBf5d453649824C7bfCB6c8F12d743")).toBe(
      "send to [redacted-key]",
    );
  });

  it("leaves ordinary conversational text alone", () => {
    const text = "What is the current Dated SIU price and how is it computed?";
    expect(stripSensitive(text)).toBe(text);
  });

  it("redacts multiple occurrences in one message", () => {
    expect(stripSensitive("email a@b.com or b@c.com")).toBe(
      "email [redacted-email] or [redacted-email]",
    );
  });
});
