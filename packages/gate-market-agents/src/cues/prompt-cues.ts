/**
 * Readers of the structured sections the loop renders into an agent's prompt: the board's open requests and
 * the sellers' "you have been paid" lines. Shared by the scripted policy (a debug mode) and the lab's issuer
 * service (a production component), so that the service never has to import debug-only code. Each anchors on
 * the section's own header at the start of a line, so a tool description or a history line quoting the same
 * words cannot match. Tested against the loop's own renderers in `cli/scripted-policy.test.ts`.
 */

/**
 * The lines of one prompt section: everything after `header` up to a blank line or the next line
 * that starts in column 0. The second stop matters — the board renders its sections back to back
 * with no blank line between, so a section that ran to the blank line would swallow the next one's
 * items (the quotes a buyer has RECEIVED would be read as work a seller is OWED).
 */
export function sectionLines(prompt: string, header: RegExp): string[] {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => header.test(l));
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || /^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** `Open quote requests addressed to you` — what a seller is asked to quote. */
export function openRequests(prompt: string): { requestId: string; from: string; siu: string }[] {
  return sectionLines(prompt, /^Open quote requests addressed to you/)
    // A requester is named by a seat (ORCHESTRATOR) or, in the currency lab, a label (TRADER-2): digits too.
    .map((l) => /^\s+(qr-\d+): from ([A-Z0-9-]+), ([\d.]+) SIU,/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ requestId: m[1], from: m[2], siu: m[3] }));
}

/** `YOU HAVE BEEN PAID AND OWE THE WORK` — dollar-route quotes this seller must now deliver. */
export function owedInUsdc(prompt: string): string[] {
  return sectionLines(prompt, /^YOU HAVE BEEN PAID AND OWE THE WORK/)
    .map((l) => /^\s+answers (qr-\d+):/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

