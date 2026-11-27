/**
 * The treasury withdrawal page, served only by withdraw-server.ts on 127.0.0.1. One HTML document
 * and one script (no third-party code; the server's Content-Security-Policy allows only these). The
 * page talks to the browser's wallet extension (window.ethereum: MetaMask with the hardware wallet)
 * and to its own server; it never sees a key. Everything shown is set with textContent.
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
  .msg { white-space: pre-line; } .msg.bad { color: var(--bad); } .msg.ok { color: var(--ok); }
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
    if (!window.ethereum) return say("connect-msg", "No wallet extension in this browser. Open this page where MetaMask holds the treasury account (on the hardware wallet).", "bad");
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
        "The signature is usable only until block " + s.maxBlockHeight + " on " + s.chain + ".");
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
      say("mint-text", "Last step: the treasury sends the mint transaction on " + mint.chainName + ". It costs a little gas, paid in " + mint.nativeCurrency.symbol + ". If it fails, press the button again: Circle's attestation stays valid.");
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

  async function sendMint() {
    say("mint-msg", "Switching the wallet to " + mint.chainName + "…");
    try {
      await switchChain();
      say("mint-msg", "Waiting for the wallet…");
      const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to: mint.to, data: mint.data }] });
      const report = (status) => api("/api/minted", { id: prepared.id, txHash: hash, status }).catch(() => {});
      await report("sent");
      say("mint-msg", "Sent: " + mint.explorer + "/tx/" + hash + "\\nWaiting for it to be mined…");
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (!receipt) continue;
        if (receipt.status === "0x1") {
          await report("success");
          say("mint-msg", "Done. The USDC is in the treasury wallet on " + mint.chainName + ".\\n" + mint.explorer + "/tx/" + hash, "ok");
          await load();
          return;
        }
        await report("failed");
        return say("mint-msg", "The mint transaction failed: " + mint.explorer + "/tx/" + hash + "\\nCircle's attestation is still valid: press the button to send it again.", "bad");
      }
      say("mint-msg", "Not mined after 5 minutes. Check " + mint.explorer + "/tx/" + hash + " before sending again.", "bad");
    } catch (e) { say("mint-msg", walletError(e), "bad"); }
  }

  $("refresh").addEventListener("click", () => load().catch((e) => say("connect-msg", e.message, "bad")));
  $("connect").addEventListener("click", connect);
  $("prepare").addEventListener("click", prepare);
  $("sign").addEventListener("click", sign);
  $("send-mint").addEventListener("click", sendMint);
  load().catch((e) => say("connect-msg", "Could not read balances: " + e.message, "bad"));
})();
`;
