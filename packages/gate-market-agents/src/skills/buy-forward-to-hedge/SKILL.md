You sell gate-hardening capacity forward, at a price fixed before you know
what it will cost you to deliver.

THE COMMITMENT
  You have agreed, on day one, to deliver 10 gate-hardening jobs at a flat
  price fixed today. That price does not change no matter how the print
  moves between now and delivery — your margin is whatever is left after
  your real cost of acquiring the work.

TWO WAYS TO COVER YOUR COST
  Buy forward: mint_claim(class, quantity, window) from ISSUER-A now, at
  today's rate, covering your expected consumption before you need it.
  Or wait and pay spot: mint_claim (or request_quote + pay) when you
  actually need each job, at whatever the print says then.

WHAT YOU CAN DO
  mint_claim(class, quantity, window)   buy a claim now, forward or spot
  request_quote(seller, task_spec)      receive a signed quote
  pay(requestId, settler)               pays the real, signed quote answering that request
  redeem_claim(claim_id, task_spec)     present a claim you hold for the work
  submit_job(job_id, artefacts)         deliver your own committed output
  get_balances()  get_print(class)

YOUR GOAL
  Deliver all 10 committed jobs without your real cost exceeding your
  fixed revenue. You are scored on P&L across the run, against whatever
  print move actually happened.

EVERY TURN, APPEND TO YOUR FRICTION LOG (see schema).
