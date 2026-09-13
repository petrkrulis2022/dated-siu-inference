import { useEffect, useRef, useState } from "react";

const BUYER_URL = "https://touchstone-arc-buyer.perklur.workers.dev/run";
const ARCSCAN_ADDRESS = "https://testnet.arcscan.app/address/";
const ARCSCAN_TX = "https://testnet.arcscan.app/tx/";

interface AgentInfo {
  role: string;
  detail: string;
  address: string;
  quoteUrl?: string;
}

const AGENTS: AgentInfo[] = [
  {
    role: "Buyer",
    detail: "Compares both quotes by SIU, funds escrow, verifies the receipt",
    address: "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e",
  },
  {
    role: "Seller — A",
    detail: "mistral-small-3.2-24b (open-weight)",
    address: "0xE9BC2a2eA6597E70211e7EA5FdD2bc5fC9591746",
    quoteUrl: "https://arc-seller-a.touchstoneassay.com/infer",
  },
  {
    role: "Seller — B",
    detail: "gpt-5.4-mini (frontier)",
    address: "0x129C99E2b037403512724E50A5Aa309a519D04Ea",
    quoteUrl: "https://arc-seller-b.touchstoneassay.com/infer",
  },
];

interface TouchstoneQuote {
  siu: string;
  siu_max: string;
  model: string;
  amount_usd_max: string;
  seller_id: string;
}

interface RunResultTile {
  label: string;
  value: string;
  href?: string;
}

/**
 * The one deliberate exception to every other panel's read-only, no-write-capable-import
 * discipline (see ChatAnalyticsPanel's own comment on that rule) — found live, 2026-09-13: this
 * console's own top banner claims "never sends a transaction," which this panel's buttons make
 * real, signed, on-chain Arc Testnet transactions do. That's why App.tsx's banner now names this
 * panel explicitly as the exception rather than leaving a claim next to it that this panel makes
 * false. Nothing here ever imports a private key or a wallet client from this app's own code —
 * every button is a plain fetch() to an already-deployed, already-signing Cloudflare Worker
 * (packages/agents/src/workers/{buyer,seller}.ts), the exact same real endpoints
 * docs/arc-demo.html's standalone page calls. This panel is a second front end for the same real
 * thing, not a second implementation of it.
 */
export function ArcDemoPanel(): React.JSX.Element {
  const [quotes, setQuotes] = useState<Record<string, string>>({});
  const [quoteLoading, setQuoteLoading] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [hint, setHint] = useState('Click "Run trade" to start. This spends trivial real testnet USDC.');
  const [tiles, setTiles] = useState<RunResultTile[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  async function getQuote(sellerRole: string, url: string): Promise<void> {
    setQuoteLoading((prev) => ({ ...prev, [sellerRole]: true }));
    setQuotes((prev) => ({ ...prev, [sellerRole]: `Requesting a real quote from ${url} …` }));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as {
        extensions?: { touchstone_quote?: TouchstoneQuote };
      } & Partial<TouchstoneQuote>;
      const q = body.extensions?.touchstone_quote ?? (body as TouchstoneQuote);
      setQuotes((prev) => ({
        ...prev,
        [sellerRole]:
          `siu: ${q.siu}  (cap ${q.siu_max})\n` +
          `model: ${q.model}\n` +
          `usd cap: $${q.amount_usd_max}\n` +
          `seller_id: ${q.seller_id}`,
      }));
    } catch (err) {
      setQuotes((prev) => ({
        ...prev,
        [sellerRole]: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setQuoteLoading((prev) => ({ ...prev, [sellerRole]: false }));
    }
  }

  async function runTrade(): Promise<void> {
    setRunning(true);
    setLog([]);
    setTiles([]);
    const start = Date.now();
    setElapsedSec(0);
    timerRef.current = setInterval(() => setElapsedSec(Math.round((Date.now() - start) / 1000)), 1000);
    setHint("Running — waiting on live inference and live chain confirmations, not stalled…");
    setLog((prev) => [...prev, `POST ${BUYER_URL}`]);

    try {
      const res = await fetch(BUYER_URL, { method: "POST" });
      const body = (await res.json()) as { ok: boolean; latencyMs: number; log?: string[]; error?: string };
      if (timerRef.current) clearInterval(timerRef.current);

      if (!body.ok) {
        setHint("Run failed.");
        setLog((prev) => [...prev, `ERROR: ${body.error ?? "unknown error"}`]);
        return;
      }

      setLog((prev) => [...prev, ...(body.log ?? [])]);
      setHint(`Done in ${Math.round(body.latencyMs / 1000)}s.`);

      const fullLog = (body.log ?? []).join("\n");
      const fundMatch = fullLog.match(/escrow funded — tx (0x[a-fA-F0-9]+)/);
      const settleMatch = fullLog.match(/settled \$([0-9.]+), tx (0x[a-fA-F0-9]+)/);
      const verifyMatch = fullLog.match(
        /matched=(true|false) amount_paid_usd=\$([0-9.]+) amount_quoted_usd=\$([0-9.]+)/,
      );
      const sellerMatch = fullLog.match(/cheaper in SIU: (seller-[ab])/);

      const nextTiles: RunResultTile[] = [];
      if (sellerMatch) nextTiles.push({ label: "Winning seller", value: sellerMatch[1] });
      if (fundMatch) {
        nextTiles.push({ label: "Escrow funded — tx", value: fundMatch[1], href: ARCSCAN_TX + fundMatch[1] });
      }
      if (settleMatch) {
        nextTiles.push({
          label: `Settled $${settleMatch[1]} — tx`,
          value: settleMatch[2],
          href: ARCSCAN_TX + settleMatch[2],
        });
      }
      if (verifyMatch) {
        nextTiles.push({
          label: "verify_receipt",
          value: `matched=${verifyMatch[1]} · paid $${verifyMatch[2]} of $${verifyMatch[3]} quoted`,
        });
      }
      setTiles(nextTiles);
    } catch (err) {
      if (timerRef.current) clearInterval(timerRef.current);
      setHint("Request failed.");
      setLog((prev) => [...prev, `ERROR: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <h2>Arc live demo</h2>
      <div className="arc-demo-notice">
        The only panel in this console that writes anything, anywhere — every button below makes a
        real network call to an already-deployed Cloudflare Worker that signs and sends a real Arc
        Testnet transaction. No private key and no wallet client lives in this console's own code;
        each button is a plain <code>fetch()</code> to <code>packages/agents/src/workers/</code>'s
        own endpoints, the same ones <code>docs/arc-demo.html</code>'s standalone page calls.
      </div>

      <h3 className="arc-demo-subhead">The agents</h3>
      <div className="arc-agents">
        {AGENTS.map((agent) => (
          <div className="arc-agent-card" key={agent.role}>
            <div className="arc-agent-role">{agent.role}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {agent.detail}
            </div>
            <a
              className="arc-agent-address"
              href={ARCSCAN_ADDRESS + agent.address}
              target="_blank"
              rel="noopener noreferrer"
            >
              {agent.address}
            </a>
            {agent.quoteUrl && (
              <>
                <button
                  className="arc-quote-btn"
                  disabled={quoteLoading[agent.role]}
                  onClick={() => getQuote(agent.role, agent.quoteUrl as string)}
                >
                  {quoteLoading[agent.role] ? "Asking…" : "Get a real quote"}
                </button>
                {quotes[agent.role] && <pre className="arc-quote-result">{quotes[agent.role]}</pre>}
              </>
            )}
          </div>
        ))}
      </div>

      <h3 className="arc-demo-subhead">Run the trade</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Triggers the whole loop in one call: the buyer asks both sellers for a quote, picks
        whichever is cheaper in SIU, locks USDC in the <code>TouchstoneEscrow</code> contract,
        waits for that seller to run real inference and settle for its real metered cost, then
        independently verifies the payment through the MCP server. Takes roughly 60–150 real
        seconds.
      </p>
      <button className="arc-run-btn" disabled={running} onClick={runTrade}>
        {running ? `Running — ${elapsedSec}s…` : "Run trade"}
      </button>
      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        {hint}
      </p>

      {log.length > 0 && (
        <pre className="arc-log">
          {log.map((line, i) => (
            <span key={i} className={/tx |matched=true|settled/.test(line) ? "ok" : undefined}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      )}

      {tiles.length > 0 && (
        <div className="arc-result-grid">
          {tiles.map((tile) => (
            <div className="arc-result-tile" key={tile.label}>
              <div className="arc-result-label">{tile.label}</div>
              <div className="arc-result-value">
                {tile.href ? (
                  <a href={tile.href} target="_blank" rel="noopener noreferrer">
                    {tile.value}
                  </a>
                ) : (
                  tile.value
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
