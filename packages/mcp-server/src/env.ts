/**
 * A minimal, local copy of packages/print/src/sign/sign.ts's env-key convention — reading
 * `DATUM_PUBLISHER_KEY` directly rather than importing @datum/print for one helper function,
 * which would pull @datum/basket and @datum/harness in as transitive workspace deps for no
 * other reason.
 */
export const PUBLISHER_KEY_ENV = "DATUM_PUBLISHER_KEY";
export const SELLER_ADDRESS_ENV = "DATUM_SELLER_ADDRESS";

export function loadPublisherKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[PUBLISHER_KEY_ENV];
  if (!key) {
    throw new Error(
      `${PUBLISHER_KEY_ENV} is not set. verify_receipt signs with the same publisher key ` +
        `prints are signed with; it is never committed and never defaulted.`,
    );
  }
  return key;
}

/** The EVM wallet address Circle's Gateway middleware pays out to — build1-spec.md §9. */
export function loadSellerAddressFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const address = env[SELLER_ADDRESS_ENV];
  if (!address) {
    throw new Error(
      `${SELLER_ADDRESS_ENV} is not set. The Gateway paywall needs a real wallet address to ` +
        `receive USDC payments; there is no sensible default to fall back to.`,
    );
  }
  return address;
}
