/** Shared by every tool that writes to a chain and then reads the result back. */
/**
 * Polls until `ok(value)` holds, then returns the value; throws if it never does.
 *
 * **Why a receipt is not enough.** A load-balanced public endpoint can serve a pre-write view AFTER
 * a transaction's receipt confirms (the sixth documented instance of that pattern, found live: the
 * `createLot` simulation ran straight after the approval's receipt and saw no allowance). So after
 * every write the tool waits for the write's own EFFECT to be readable before depending on it.
 * It waits for the effect and not for the value to stop changing — two consecutive stale reads
 * agree with each other and are still wrong. A read that never shows the effect throws; it does
 * not fall through to acting on what was last seen.
 */
export async function untilVisible<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  pollMs: number,
  attempts = 30,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`${what} was not visible after ${attempts} reads (last read: ${String(last)})`);
}
