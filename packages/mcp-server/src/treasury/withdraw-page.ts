/**
 * The treasury withdrawal page, served only by withdraw-server.ts on 127.0.0.1. One HTML document
 * and one script (no third-party code; the server's Content-Security-Policy allows only these). The
 * page talks to the browser's wallet extension (window.ethereum: the treasury's account in MetaMask, a
 * dedicated hot wallet until the treasury holds more than $100) and to its own server; it never sees
 * a key. Everything shown is set with textContent.
 */

export const WITHDRAW_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Treasury withdrawal</title>
<style>
  :root { --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --ok: #1d6b3a; --bad: #a3221b; --main: #a3221b; --test: #1f4fa3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #eee; --muted: #aaa; --line: #333; --ok: #6fcf8f; --bad: #ff8a80; --main: #ff8a80; --test: #8ab4ff; } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 720px; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .network { font-weight: 700; letter-spacing: .05em; }
  .network.mainnet { color: var(--main); } .network.testnet { color: var(--test); }
  section { border-top: 1px solid var(--line); padding: 12px 0; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px 4px 0; }
  td.num { font-variant-numeric: tabular-nums; }
  code, .mono { font-family: ui-monospace, monospace; word-break: break-all; }
  button { font: inherit; padding: 6px 14px; margin: 4px 8px 4px 0; cursor: pointer; }
  input, select { font: inherit; padding: 4px 6px; }
  .msg { white-space: pre-line; } .msg.bad { color: var(--bad); } .msg.ok { color: var(--ok); } .msg.warn { color: var(--warn); }
  :root { --warn: #8a5a00; } @media (prefers-color-scheme: dark) { :root { --warn: #f0c060; } }
  .muted { color: var(--muted); font-size: .9em; }
  [hidden] { display: none !important; }
  details pre { overflow-x: auto; font-size: .8em; }
</style>
</head>
<body>
<h1>Treasury withdrawal</h1>
<p><span id="network" class="network"></span> · Gateway balance → treasury wallet, same chain · <span class="muted">local page, holds no key</span></p>

<section>
  <div>Treasury: <code id="treasury"></code></div>
  <table><thead><tr><th>Chain</th><th>Gateway balance (USDC)</th></tr></thead><tbody id="balances"></tbody></table>
  <button id="refresh">Refresh balances</button>
</section>

<section>
  <button id="connect">Connect wallet</button> <span id="account" class="mono"></span>
  <div id="connect-msg" class="msg"></div>
</section>

<section id="form-section" hidden>
  <label>Chain <select id="chain"></select></label>
  <label>Amount (USDC) <input id="amount" inputmode="decimal" size="12" placeholder="0.50"></label>
  <button id="prepare">Prepare</button>
  <div id="prepare-msg" class="msg"></div>
</section>

<section id="review-section" hidden>
  <div id="summary" class="msg"></div>
  <details><summary>Exactly what you will sign</summary><pre id="typed"></pre></details>
  <button id="sign">Sign with the wallet</button>
  <div id="sign-msg" class="msg"></div>
</section>

<section id="mint-section" hidden>
  <div id="mint-text" class="msg"></div>
  <button id="send-mint">Send the mint transaction</button>
  <div id="confirm-box" hidden>
    <div id="confirm-notice" class="msg warn"></div>
    <p>To go ahead anyway, type exactly: <code id="confirm-phrase"></code></p>
    <input id="confirm-input" size="44" autocomplete="off" spellcheck="false">
    <button id="confirm-send">Confirm and send the mint</button>
  </div>
  <div id="mint-msg" class="msg"></div>
</section>

<script src="/app.js"></script>
</body>
</html>
`;

export const WITHDRAW_PAGE_JS = `"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  let state = null, account = null, prepared = null, mint = null;

  function say(id, text, kind) {
    const el = $(id);
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }

  function walletError(e) {
    if (e && e.code === 4001) return "You declined in the wallet. Nothing happened.";
    return (e && (e.message || e.error)) || String(e);
  }

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  async function load() {
    state = await api("/api/state");
    const net = $("network");
    net.textContent = state.network === "mainnet" ? "MAINNET: real money" : "TESTNET";
    net.className = "network " + state.network;
    $("treasury").textContent = state.treasury;
    const tbody = $("balances");
    tbody.replaceChildren();
    const select = $("chain");
    const chosen = select.value;
    select.replaceChildren();
    for (const c of state.chains) {
      const tr = document.createElement("tr");
      const name = document.createElement("td"); name.textContent = c.name;
      const bal = document.createElement("td"); bal.className = "num"; bal.textContent = c.balance;
      tr.append(name, bal); tbody.append(tr);
      const opt = document.createElement("option"); opt.value = c.key; opt.textContent = c.name + " (" + c.balance + " USDC)";
      select.append(opt);
    }
    if (chosen) select.value = chosen;
  }

  async function connect() {
    say("connect-msg", "");
    if (!window.ethereum) return say("connect-msg", "No wallet extension in this browser. Open this page where MetaMask holds the treasury account.", "bad");
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = accounts[0];
      $("account").textContent = account;
      if (!account || account.toLowerCase() !== state.treasury.toLowerCase()) {
        $("form-section").hidden = true;
        return say("connect-msg", "This is not the treasury. Switch the wallet to " + state.treasury + " and connect again.", "bad");
      }
      say("connect-msg", "Connected to the treasury.", "ok");
      $("form-section").hidden = false;
    } catch (e) { say("connect-msg", walletError(e), "bad"); }
  }

  async function prepare() {
    say("prepare-msg", "Asking Circle for the fee…");
    $("review-section").hidden = true; $("mint-section").hidden = true; prepared = null; mint = null;
    try {
      prepared = await api("/api/prepare", { chain: $("chain").value, amount: $("amount").value.trim() });
      const s = prepared.summary, m = prepared.typedData.message;
      say("prepare-msg", "");
      say("summary",
        "Withdraw " + s.amount + " USDC from the treasury's Gateway balance on " + s.chain + " to the treasury's own wallet " + s.recipient + ".\\n" +
        "Circle's fee: at most " + s.maxFee + " USDC, taken from the Gateway balance on top of the amount.\\n" +
        "Gateway balance now " + s.balance + " USDC; afterwards at least " + s.balanceAfterAtLeast + " USDC.\\n\\n" +
        "The wallet will ask you to sign a BurnIntent for GatewayWallet, version 1. On the device, check:\\n" +
        "  value " + m.spec.value + " (USDC has 6 decimals: " + s.amount + ")\\n" +
        "  maxFee " + m.maxFee + "\\n" +
        "  destinationRecipient ending " + s.recipient.slice(-8).toLowerCase() + "\\n" +
        "The signature is usable only until block " + s.maxBlockHeight + " on " + s.chain + "." +
        (s.notice ? "\\n\\nNote: " + s.notice : ""));
      $("typed").textContent = JSON.stringify(prepared.typedData, null, 2);
      $("review-section").hidden = false;
    } catch (e) { say("prepare-msg", e.message, "bad"); }
  }

  async function sign() {
    say("sign-msg", "Waiting for the wallet…");
    try {
      const signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(prepared.typedData)] });
      say("sign-msg", "Signed. Sending to Circle…");
      const res = await api("/api/submit", { id: prepared.id, signature });
      mint = res.mint;
      say("sign-msg", "Circle attested the withdrawal" + (res.transferId ? " (transfer " + res.transferId + ")" : "") + ".", "ok");
      say("mint-text", "Last step, within 10 minutes: the treasury sends the mint transaction on " + mint.chainName + ". It costs a little gas, paid in " + mint.nativeCurrency.symbol + ". " +
        (state.network === "mainnet"
          ? "Your wallet may send it through a smart account and its own relayer; before sending, the page says what may happen and asks you to type a confirmation."
          : "Testnet is strict: the treasury must send it itself, as a plain transaction; if the wallet offers a smart account, gas sponsorship or a relayer, decline.") +
        " Circle's approval expires after 10 minutes; if that happens nothing is lost, the amount returns to the Gateway balance and you prepare again.");
      $("mint-section").hidden = false;
    } catch (e) { say("sign-msg", walletError(e), "bad"); }
  }

  async function switchChain() {
    const chainId = "0x" + mint.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!e || e.code !== 4902) throw e;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId, chainName: mint.chainName, rpcUrls: [mint.rpcUrl], nativeCurrency: mint.nativeCurrency, blockExplorerUrls: [mint.explorer] }] });
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
  }

  function factsText(f) {
    if (!f) return "";
    const lines = ["status: " + f.status];
    if (f.sender) lines.push("sender: " + f.sender, "type: " + f.type, "target: " + f.target, "data: " + f.data, "received by the treasury: " + f.receivedByTreasury);
    return "Exactly what happened:\\n  " + lines.join("\\n  ");
  }

  // Testnet: the server stops if the treasury is not a plain account. Mainnet (owner's decision,
  // 2026-11-28): the server says what the wallet may do and asks for a typed phrase before every mint.
  async function sendMint(confirmation) {
    say("mint-msg", "Checking the treasury on " + mint.chainName + "…");
    $("confirm-box").hidden = true;
    let check;
    try {
      check = await api("/api/mint-check", confirmation === undefined ? { id: prepared.id } : { id: prepared.id, confirmation });
    } catch (e) { return say("mint-msg", e.message, "bad"); }
    if (!check.ok) {
      $("confirm-notice").textContent = check.notice;
      $("confirm-phrase").textContent = check.phrase;
      $("confirm-box").hidden = false;
      return say("mint-msg", confirmation === undefined ? "" : "That is not the exact phrase; nothing was sent.", confirmation === undefined ? "" : "bad");
    }
    say("mint-msg", "Switching the wallet to " + mint.chainName + "…");
    try {
      await switchChain();
      say("mint-msg", "Waiting for the wallet…");
      const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to: mint.to, data: mint.data }] });
      await api("/api/minted", { id: prepared.id, txHash: hash, status: "sent" }).catch(() => {});
      say("mint-msg", "Sent: " + mint.explorer + "/tx/" + hash + "\\nWaiting for it to be mined…");
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (!receipt) continue;
        say("mint-msg", "Mined. Checking it on " + mint.chainName + "…");
        let v;
        try {
          v = await api("/api/minted", { id: prepared.id, txHash: hash, status: "mined" });
        } catch (e) {
          return say("mint-msg", "Mined, but the check of it failed: " + e.message + "\\nDo not count this as done: check " + mint.explorer + "/tx/" + hash, "bad");
        }
        const link = mint.explorer + "/tx/" + hash;
        if (v.verdict === "plain") {
          say("mint-msg", "Done. Checked on chain: a plain transaction from the treasury to the GatewayMinter, which minted " + prepared.summary.amount + " USDC to the treasury on " + mint.chainName + ".\\n" + factsText(v.facts) + "\\n" + link, "ok");
          await load();
          return;
        }
        await load().catch(() => {});
        if (v.accepted)
          return say("mint-msg", "Completed, but not as a plain mint from the treasury. You accepted this before sending; the record says so.\\n- " + v.problems.join("\\n- ") + "\\n" + factsText(v.facts) + "\\n" + link, "warn");
        return say("mint-msg", "NOT done as designed. Checked on chain:\\n- " + v.problems.join("\\n- ") + "\\n" + factsText(v.facts) + "\\n" + link + "\\nThe USDC may still have reached the treasury: check its balance. Do not withdraw on mainnet until this is understood.", "bad");
      }
      say("mint-msg", "Not mined after 5 minutes. Check " + mint.explorer + "/tx/" + hash + " before doing anything else.", "bad");
    } catch (e) { say("mint-msg", walletError(e), "bad"); }
  }

  $("refresh").addEventListener("click", () => load().catch((e) => say("connect-msg", e.message, "bad")));
  $("connect").addEventListener("click", connect);
  $("prepare").addEventListener("click", prepare);
  $("sign").addEventListener("click", sign);
  $("send-mint").addEventListener("click", () => sendMint());
  $("confirm-send").addEventListener("click", () => sendMint($("confirm-input").value));
  load().catch((e) => say("connect-msg", "Could not read balances: " + e.message, "bad"));
})();
`;
