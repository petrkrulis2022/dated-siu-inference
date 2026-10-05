/**
 * A completion that ran out of tokens before emitting any text.
 *
 * That is the harness's failure, not the agent's. The agent never got as far as deciding anything:
 * a reasoning model spent its whole output budget thinking and returned nothing to parse. Scoring
 * it as the agent's turn — it used to end as `no_text_emitted`, and a window that then never
 * delivered was recorded as `no_gate` — misreads a budget fact as behaviour, in a run whose whole
 * measurement is what agents choose. The loop retries the turn once; if the retry is empty too,
 * the run is declared infrastructure-failed and excluded.
 *
 * Deliberately narrow. A reply that was truncated AFTER it began is text the model chose to emit
 * and is still the model's; an empty completion that ended for any other reason (the model
 * stopped of its own accord) is still the model's too. Only "out of budget, nothing said" is.
 *
 * The three spellings are each provider's own word for it, as the adapters pass them through:
 * Anthropic `max_tokens`, OpenAI-shaped `length`, Google `MAX_TOKENS`.
 */
export function isEmptyAtTokenBudget(result: { text: string; stopReason?: string }): boolean {
  if (result.text.trim() !== "") return false;
  if (result.stopReason === undefined) return false;
  return /^(max_tokens|length)$/i.test(result.stopReason.trim());
}
