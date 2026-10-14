import { describe, expect, it } from "vitest";
import { EXCLUDED_FIELDS, RAW_PRINT_URL, VERIFY_SCRIPT_URL, buildVerificationSpec, verificationExampleOf } from "./verify-recipe.js";
import type { ChainInfo } from "./data.js";

const BASE: ChainInfo = { slug: "base-sepolia", name: "Base Sepolia", chainId: 84532, attestationAddress: "0xF60701793eD168ffd6e818e1DCcb600393297190", publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a", explorerBaseUrl: "https://base-sepolia.blockscout.com", anchoringLive: true };
const ARC: ChainInfo = { slug: "arc-testnet", name: "Arc Testnet", chainId: 5042002, attestationAddress: "0x12b886b043feABc3d90bBae3ae206d22b208160d", publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a", explorerBaseUrl: "https://testnet.arcscan.app", anchoringLive: false };

interface SpecView {
  body_hash: { remove_fields: string[]; canonicalisation: string; hash: string };
  chains: { slug: string; chain_id?: number; attestation_contract: string; publisher: string; explorer: string; publisher_immutable: boolean; anchoring: string; abi: string[] }[];
  print: { raw_url_template: string };
  run_it_for_you: { script_url: string; does_not_check: string };
  worked_example: { print_id: string };
  what_it_proves: string;
}

describe("buildVerificationSpec", () => {
  const spec = buildVerificationSpec({ chains: [BASE, ARC], example: { print_id: "2026-10-14", body_hash: "0x" + "ab".repeat(32) } }) as SpecView;

  it("states the five removed fields, the canonicalisation and the hash, in words a program can act on", () => {
    expect(spec.body_hash.remove_fields).toEqual([...EXCLUDED_FIELDS]);
    expect(spec.body_hash.canonicalisation).toMatch(/RFC 8785/);
    expect(spec.body_hash.hash).toMatch(/keccak256/);
    expect(spec.body_hash.hash).toMatch(/not NIST SHA3-256/);
  });

  it("lists both chains in order, with contract, publisher, explorer and the ABI to call", () => {
    expect(spec.chains.map((c) => c.slug)).toEqual(["base-sepolia", "arc-testnet"]);
    const [base, arc] = spec.chains;
    expect(base).toMatchObject({ chain_id: 84532, attestation_contract: BASE.attestationAddress, publisher: BASE.publisherAddress, explorer: BASE.explorerBaseUrl, publisher_immutable: true });
    expect(base.abi).toContain("function postedAt(bytes32 bodyHash) view returns (uint64)");
    expect(arc.attestation_contract).toBe(ARC.attestationAddress);
  });

  it("says plainly that Arc Testnet is not anchored on yet, and Base Sepolia is", () => {
    expect(spec.chains[0].anchoring).toMatch(/^live/);
    expect(spec.chains[1].anchoring).toMatch(/^not yet live/);
  });

  it("says where each chain's anchor lives, so an agent reads the Arc entry from the right field", () => {
    const view = spec as unknown as { anchor_field: { location: string; status_values: string[]; hash_recipe_unchanged: string }; steps: string[] };
    expect(view.anchor_field.location).toContain("anchor.additional_anchors");
    expect(view.anchor_field.status_values).toEqual(["anchored", "already-anchored", "failed", "skipped"]);
    expect(view.anchor_field.hash_recipe_unchanged).toMatch(/never changes the body hash/);
    expect(view.steps.join(" ")).toContain("anchor.additional_anchors");
  });

  it("words a live further chain from its start date and as best-effort, with no date when none is known", () => {
    const live = buildVerificationSpec({ chains: [BASE, { ...ARC, anchoringLive: true, anchoringStartedOn: "2026-10-15" }] }) as SpecView;
    expect(live.chains[1].anchoring).toMatch(/^live: prints dated 2026-10-15 and later/);
    expect(live.chains[1].anchoring).toMatch(/best-effort/);
    expect(live.chains[0].anchoring).toBe("live: every print is anchored here");
  });

  it("points at the raw print, the one-command script and carries a worked example", () => {
    expect(spec.print.raw_url_template).toBe(`${RAW_PRINT_URL}{print_id}.json`);
    expect(spec.run_it_for_you.script_url).toBe(VERIFY_SCRIPT_URL);
    expect(spec.run_it_for_you.does_not_check).toBe("the signature");
    expect(spec.worked_example.print_id).toBe("2026-10-14");
  });

  it("says what anchoring proves and what it does not", () => {
    expect(spec.what_it_proves).toMatch(/does not prove the print's numbers are right/);
  });

  it("omits the worked example when there is none", () => {
    expect("worked_example" in (buildVerificationSpec({ chains: [BASE] }) as object)).toBe(false);
  });
});

describe("verificationExampleOf", () => {
  const H = "0x" + "cd".repeat(32);
  const T1 = "0x" + "11".repeat(32);
  const T2 = "0x" + "22".repeat(32);

  it("carries the first chain's anchor and each further anchor that landed, and nothing for one that did not", () => {
    const ex = verificationExampleOf(
      { print_id: "2026-10-15", anchor: { chain: "base-sepolia", status: "anchored", tx_hash: T1, additional_anchors: [{ chain: "arc-testnet", status: "anchored", tx_hash: T2 }, { chain: "other", status: "failed" }, { chain: "x", status: "skipped" }] } },
      H,
    );
    expect(ex).toEqual({ print_id: "2026-10-15", body_hash: H, anchor: { chain: "base-sepolia", tx_hash: T1 }, additional_anchors: [{ chain: "arc-testnet", tx_hash: T2 }] });
  });

  it("is just id and hash for a print with no anchor, and has no additional_anchors key when none landed", () => {
    expect(verificationExampleOf({ print_id: "p" }, H)).toEqual({ print_id: "p", body_hash: H });
    const ex = verificationExampleOf({ print_id: "p", anchor: { chain: "base-sepolia", status: "anchored", tx_hash: T1, additional_anchors: [{ chain: "arc-testnet", status: "failed", tx_hash: T2 }] } }, H);
    expect("additional_anchors" in ex).toBe(false);
  });

  it("does not present an anchor whose status is not 'anchored' as one to test against", () => {
    expect("anchor" in verificationExampleOf({ print_id: "p", anchor: { chain: "base-sepolia", status: "failed", tx_hash: T1 } }, H)).toBe(false);
  });
});

