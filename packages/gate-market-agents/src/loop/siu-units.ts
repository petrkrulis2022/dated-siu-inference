/**
 * SIU as a decimal string -> milli-SIU as an integer string, with no floats anywhere near it
 * (invariant 4). A quote states its size in SIU ("10", "0.004"); a claim is minted in milli-SIU.
 *
 * Refuses rather than rounds. More than three decimal places is a fraction of a milli-SIU, which
 * no claim can express, and silently truncating it would settle a quote for less than it states.
 */
export function decimalSiuToMilliSiu(siu: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(siu.trim());
  if (!m) throw new Error(`"${siu}" is not a decimal SIU quantity.`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > 3 && /[1-9]/.test(frac.slice(3))) {
    throw new Error(
      `${siu} SIU is a fraction of a milli-SIU. A claim cannot express it, and truncating would ` +
        "settle the quote for less than it states.",
    );
  }
  const milli = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  if (milli === 0n) throw new Error(`${siu} SIU is zero.`);
  return milli.toString();
}

/**
 * Milli-SIU as a decimal SIU string, exactly — the inverse of `decimalSiuToMilliSiu`. 10000 -> "10",
 * 4500 -> "4.5", 1 -> "0.001". Integers only; a quote states its size in SIU.
 */
export function milliSiuToDecimalSiu(milli: bigint): string {
  if (milli < 0n) throw new Error("a quantity cannot be negative.");
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}
