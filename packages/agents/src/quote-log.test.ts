import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQuoteBody, signQuote, quoteHashHex, type DatumQuote } from "@datum/sdk";
import { logIssuedQuote } from "./quote-log.js";

const TEST_KEY = `0x${"55".repeat(32)}`;

function quote(): DatumQuote {
  return signQuote(
    buildQuoteBody({
      siu: "0.001",
      pattern: "fixed",
      model: "demo",
      rateUsdPerSiu: "1.0000",
      indexVersion: "SIU-2026a-illustrative-demo",
      printId: "demo",
      printHash: `0x${"0".repeat(64)}`,
      sellerId: "erc8004:0x0000000000000000000000000000000000000001",
      chain: "base-sepolia",
      expiresInSeconds: 3600,
    }),
    TEST_KEY,
  );
}

describe("logIssuedQuote", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "datum-quote-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the quote to <dir>/<quoteHash>.json", async () => {
    const q = quote();
    const path = await logIssuedQuote(q, dir);
    expect(path).toBe(join(dir, `${quoteHashHex(q)}.json`));
    const reread = JSON.parse(await readFile(path, "utf-8")) as DatumQuote;
    expect(reread).toEqual(q);
  });

  it("creates the directory if it doesn't exist yet", async () => {
    const nested = join(dir, "nested", "quotes");
    const q = quote();
    const path = await logIssuedQuote(q, nested);
    const reread = JSON.parse(await readFile(path, "utf-8")) as DatumQuote;
    expect(reread.sig).toBe(q.sig);
  });
});
