import { keccak256, stringToBytes, type Hex } from "viem";

/** The task classes this testbed bonds capacity in. */
export const KNOWN_TASK_CLASSES = ["code", "extract", "longcontext"] as const;
export type KnownTaskClass = (typeof KNOWN_TASK_CLASSES)[number];

/** The real class ids `WorkClaim`/`CapacityBond` use — `keccak256(bytes(taskClass))`, matching
 * `devnet/deploy.ts`'s own CLASS_CODE/CLASS_EXTRACT exactly. */
export function classIdFor(taskClass: string): Hex {
  return keccak256(stringToBytes(taskClass));
}

/**
 * Accepts either form of a class id and returns the real 32-byte hash: a plain class name
 * ("code"), or an already-hashed `0x…` 32-byte id.
 *
 * Added 2026-09-28 after a real run in which every single one of ISSUER-B's nine `check_headroom`
 * calls failed with `Size of bytes "code" (bytes4) does not match expected size (bytes32)`. It
 * passed the obvious, human-readable thing — the class is literally called "code" everywhere in
 * its own brief and in every rendered line it saw — and nothing in the tool's description said a
 * 32-byte hash was wanted, or what that hash was. That is a tool ergonomics failure, not an agent
 * error: the boundary should accept the name an agent has and hash it here, once, rather than
 * requiring every caller to know and reproduce a hash by hand.
 */
export function resolveClassId(input: string): Hex {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as Hex;
  return classIdFor(trimmed);
}
