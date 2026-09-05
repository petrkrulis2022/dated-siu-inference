# ETHOnline 2026 submission package

_Everything needed to fill out the submission form, written once so it can be copied in rather
than composed under deadline pressure. Deadline: **Sunday, September 13, 2026, 12:00pm EDT**._

---

## What still needs a human

1. **The demo video.** ETHGlobal requires 2-4 minutes, minimum 720p, real speaking (no
   text-to-speech, no phone recording). Nobody can record this but you — see the shot list below,
   timed to fit the window with room to spare.
2. **Submitting the form itself** and picking the final track selection (see recommendation
   below — happy to be overruled).

Everything else below is ready to paste in.

---

## Track selection — recommendation

Up to 3 Partner Prizes may be selected; each needs its own integration + feedback blurb. Two
tracks are a genuine, strong fit; a third would be a stretch not backed by what was actually
built. Recommendation: **submit for two, not three** — a precise fit reads better to a judge than
a padded list, and every claim below is checkable against a real tx hash or a real file in this
repo.

| Track | Fit | Why |
|---|---|---|
| **Arc: Launch on Arc Testnet & Push to Mainnet** ($3,500) | Strong | Exactly what was built: real testnet deployment, a real end-to-end agent loop, a mainnet-ready deploy script, explicit Sept 16 awareness. |
| **Arc: Best Agentic Economy Application with Circle Agent Stack** ($1,667) | Strong | Two seller agents and a buyer agent, each holding a real wallet, transacting real USDC, autonomously, over HTTP — the exact shape this track asks for. |
| ~~Arc: Best DeFi/Onchain Finance Application~~ | Weak, not recommended | This project is a benchmark index and a pay-for-work escrow, not lending/swaps/yield/treasury — the track's own listed use cases don't match what exists here. |

---

## Project title

**Touchstone Assay**

## One-line pitch

The benchmark price of AI inference work — measured by actually buying it, not surveying list
prices — with a real agent economy paying for it in USDC on Arc.

## Project description (submission form)

Oil never got its own currency — it got a benchmark grade, Dated Brent, priced in dollars.
Touchstone Assay does the same thing for AI inference: **Dated SIU** is a fixed basket of
benchmark inference tasks, run against real provider APIs, at a defined quality bar. Its dollar
price floats and is published as a signed, dated, hash-anchored print — never surveyed from list
prices, always computed from executed runs. The publisher holds no position in what it measures.

For ETHOnline, we brought the whole loop onto Arc: two AI seller agents, each holding a real
wallet, quote a trivial inference task in SIU over HTTP; a buyer agent compares both quotes,
funds a non-custodial escrow contract in USDC, and pays the cheaper one — no human in the loop,
no mocks, real inference, real settlement, real receipt verification. Both `TouchstoneAttestation`
(anchors a print's signature) and `TouchstoneEscrow` (holds and releases the USDC) are deployed
and verified on Arc Testnet, byte-identical to their existing Base Sepolia deployment. The buyer
and both sellers run as persistent Cloudflare Workers, not a demo script that only runs once.

Arc's public mainnet opens September 16, 2026 — three days after this hackathon's own submission
deadline. Rather than claim something that can't be true yet, this submission says plainly:
**testnet-complete, with a mainnet-ready deploy script prepared.** `TouchstoneAttestation` will
deploy to Arc mainnet the moment it's live — it holds no funds, so there's nothing to lose by
moving fast. `TouchstoneEscrow` stays on testnet regardless of the date, because its real mainnet
preconditions — a Safe multisig treasury (not an EOA), a deliberately-set fee, a publisher key
generated air-gapped rather than one that's touched a laptop, and external review — are
genuinely unmet, and a hackathon deadline doesn't change that. We think that's a strength: it
shows the same engineering judgment that makes the rest of this project trustworthy.

## Judging-criteria notes (for your own reference while presenting)

- **Technicality**: a real, signed, hash-anchored measurement pipeline; a non-custodial escrow
  contract with a documented, tested no-admin-path guarantee; two chains, one contract, zero
  chain-specific code; real agents deployed as real, persistent infrastructure, not a script.
- **Originality**: commodity-benchmark framing applied to AI inference (the Dated Brent analogy)
  — a measurement standard, not a token, not a marketplace.
- **Practicality**: the index is live and public today (prints.touchstoneassay.com); the MCP
  server is a real, deployed, paid tool other agents can call right now.
- **Usability**: a chat widget on the public site answers real questions against the live print,
  with guardrails against ever inventing a number.
- **WOW factor**: the buyer/seller loop is not a screenshot — it's `POST /run` against a real,
  currently-deployed Worker, settling real (if worthless) USDC on a chain that only opened its
  public testnet a few months ago.

---

## Partner Prize #1 — Arc: Launch on Arc Testnet & Push to Mainnet

**Integration.** `TouchstoneAttestation` and `TouchstoneEscrow` are deployed and Arcscan-verified
on Arc Testnet (chain id 5042002) — a new Foundry deploy script, zero changes to the contracts
themselves, since they already took every chain-specific value as a constructor parameter. Two
seller Cloudflare Workers and one buyer Worker run the full discover→quote→compare→fund→settle→
verify loop for real, live, twice, unattended, settling real Arc Testnet USDC. A mainnet deploy
script for `TouchstoneAttestation` is written and ready; its chain-id guard is deliberately left
as an unconfirmed env-var placeholder rather than a guessed number, since Arc's real mainnet
chain id wasn't public when this was written.

**Feedback.** Genuinely useful, first-hand: (1) Arc's real gas price (~29 gwei observed) is far
above what a lot of testnet tooling assumes by default — anyone porting existing Base/EVM funding
logic should expect to raise it, not copy a value tuned elsewhere. (2) The primary
`rpc.testnet.arc.io` endpoint rate-limited under sustained real traffic; the documented dRPC/
Blockdaemon/QuickNode mirrors worked immediately and are worth surfacing more prominently in the
getting-started docs, not just in a references page. (3) Arc's own explorer (Arcscan) is
Blockscout-compatible and `forge verify-contract --verifier blockscout` worked cleanly — worth
confirming in the docs explicitly, since we had to test it rather than find it stated. (4) One
real platform gotcha, Cloudflare-side rather than Circle/Arc-side, but worth flagging since it'll
hit anyone building agents-as-Workers on Arc: Cloudflare blocks a Worker's own `fetch()` to
another Worker's bare `*.workers.dev` URL — a real custom domain sidesteps it with no code change.

## Partner Prize #2 — Arc: Best Agentic Economy Application with Circle Agent Stack

**Integration.** Two seller agents (different model families, genuinely different real
per-token costs) each hold their own wallet and quote a real inference task in SIU, returning a
signed `touchstone-quote` over a 402 Payment Required response. A buyer agent holds its own
wallet, compares both quotes by SIU (not raw dollars — the entire point of a common unit),
funds `TouchstoneEscrow` for the cheaper one, and the winning seller settles for the real,
metered cost of the real inference call it performed. Separately, the same buyer's calls to the
real, deployed MCP server's paid tools (`get_quote`, `verify_receipt`) settle through Circle's
Gateway — a real x402 402-challenge and a real signed settlement, not a bypassed paywall, for
every call outside this specific Arc demo loop.

**Feedback.** The Gateway integration itself (`@circle-fin/x402-batching`) was straightforward
and well-documented for the common case. The one friction point: our production MCP server's own
Gateway paywall hardcodes its accepted network as a literal string one layer above where the
paywall middleware itself is already generic — worth calling out in Circle's own docs as a
pattern to avoid, since it's an easy trap (works fine for one chain, quietly doesn't generalize).
We deliberately did *not* widen our own production paywall to accept Arc-settled payment as part
of this hackathon work — that's a live-production change with real payment-routing risk, and we
scoped it out rather than rush it in under deadline pressure.

---

## Video shot list (2:30-3:30 target)

1. **(15s)** Cold open on the live site, `prints.touchstoneassay.com` — say what Dated SIU is, one
   sentence, the Dated Brent analogy.
2. **(20s)** Open the chat widget on the site, ask it "what's the current Dated SIU price," show
   it answer with the real, live number — say explicitly it's calling a real tool live, not a
   canned answer.
3. **(45s)** Switch to a terminal. Trigger the deployed Arc buyer Worker
   (`curl -X POST https://touchstone-arc-buyer.<subdomain>.workers.dev/run`) and narrate the log
   as it streams: two real quotes, the SIU comparison, the real escrow funding tx, the real
   settlement, the real `verify_receipt` result. Have Arcscan open in another tab, paste in the
   escrow address, show the real `Opened`/`Settled` events landing as the terminal reports them.
3. **(30s)** Show `data/deployments/arc-testnet.json` and the two Arcscan-verified contract pages
   side by side — say plainly: byte-identical to the existing Base Sepolia deployment, zero
   contract changes needed.
4. **(30s)** State the mainnet framing directly, on camera, in your own words: Arc mainnet opens
   September 16; this submission is testnet-complete with a mainnet-ready
   `TouchstoneAttestation` deploy script; `TouchstoneEscrow` stays on testnet because [name one or
   two of the four real preconditions] are genuinely unmet — say this is a deliberate choice, not
   a gap.
5. **(15s)** Close on `docs/architecture.md`'s diagram for two seconds, say the repo link is in
   the submission, done.
