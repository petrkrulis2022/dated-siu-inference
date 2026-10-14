import { describe, expect, it } from "vitest";
import { EXCLUDED_FIELDS, RAW_PRINT_URL, VERIFY_SCRIPT_URL, buildVerificationSpec } from "./verify-recipe.js";
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
