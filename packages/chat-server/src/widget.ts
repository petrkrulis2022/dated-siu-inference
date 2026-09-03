/**
 * The widget script itself — served by this Worker at GET /widget.js (single source of truth
 * with the backend it talks to, not duplicated into site/static/). Dependency-free vanilla JS,
 * scoped CSS class names (tsa-chat-*) so it can't collide with the host page's own styles.
 * Written as a plain string (not a .js asset file) so it ships as part of this package's own
 * TypeScript build, with no separate bundling step.
 */
export const WIDGET_JS = `(function () {
  var origin = (document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src).origin
    : "https://chat.touchstoneassay.com";

  var SESSION_KEY = "touchstone-chat-session";
  function getSessionId() {
    try {
      var existing = window.localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh = crypto.randomUUID();
      window.localStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // localStorage unavailable (private mode, blocked) — fall back to an in-memory id for
      // this page load only, rather than failing to render the widget at all.
      return crypto.randomUUID();
    }
  }
  var sessionId = getSessionId();

  var style = document.createElement("style");
  style.textContent =
    ".tsa-chat-toggle{position:fixed;right:20px;bottom:20px;z-index:999999;background:#111;color:#fff;border:none;border-radius:999px;padding:12px 18px;font:14px/1.4 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}" +
    ".tsa-chat-panel{position:fixed;right:20px;bottom:76px;z-index:999999;width:320px;max-width:calc(100vw - 40px);height:420px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;font:13px/1.5 system-ui,sans-serif;color:#111}" +
    ".tsa-chat-panel.tsa-open{display:flex}" +
    ".tsa-chat-head{padding:10px 12px;border-bottom:1px solid #eee;font-weight:600}" +
    ".tsa-chat-log{flex:1;overflow-y:auto;padding:10px 12px}" +
    ".tsa-chat-msg{margin-bottom:10px;white-space:pre-wrap;word-wrap:break-word}" +
    ".tsa-chat-msg.tsa-user{color:#111;font-weight:600}" +
    ".tsa-chat-msg.tsa-assistant{color:#333}" +
    ".tsa-chat-form{display:flex;border-top:1px solid #eee}" +
    ".tsa-chat-input{flex:1;border:none;padding:10px;font:inherit;outline:none}" +
    ".tsa-chat-send{border:none;background:#111;color:#fff;padding:0 14px;cursor:pointer;font:inherit}" +
    ".tsa-chat-send:disabled{opacity:.5;cursor:default}";
  document.head.appendChild(style);

  var toggle = document.createElement("button");
  toggle.className = "tsa-chat-toggle";
  toggle.type = "button";
  toggle.textContent = "Ask about Dated SIU";

  var panel = document.createElement("div");
  panel.className = "tsa-chat-panel";
  panel.innerHTML =
    '<div class="tsa-chat-head">Touchstone Assay chat</div>' +
    '<div class="tsa-chat-log"></div>' +
    '<form class="tsa-chat-form">' +
    '<input class="tsa-chat-input" type="text" placeholder="Ask a question…" autocomplete="off" />' +
    '<button class="tsa-chat-send" type="submit">Send</button>' +
    "</form>";

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  var log = panel.querySelector(".tsa-chat-log");
  var form = panel.querySelector(".tsa-chat-form");
  var input = panel.querySelector(".tsa-chat-input");
  var sendBtn = panel.querySelector(".tsa-chat-send");

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "tsa-chat-msg tsa-" + role;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  var opened = false;
  toggle.addEventListener("click", function () {
    opened = !opened;
    panel.classList.toggle("tsa-open", opened);
    if (opened && log.children.length === 0) {
      addMessage(
        "assistant",
        "Ask about the current Dated SIU print, the methodology, or how the MCP tools work. This is a testbed widget — nothing said here is a quote or a commitment."
      );
    }
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMessage("user", text);
    sendBtn.disabled = true;

    fetch(origin + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, message: text }),
    })
      .then(function (res) {
        if (res.status === 429) return { reply: "Too many messages — please slow down a little." };
        if (!res.ok) return { reply: "Something went wrong on this end — try again in a moment." };
        return res.json();
      })
      .then(function (data) {
        addMessage("assistant", (data && data.reply) || "No reply came back — try again.");
      })
      .catch(function () {
        addMessage("assistant", "Couldn't reach the chat service — try again in a moment.");
      })
      .finally(function () {
        sendBtn.disabled = false;
      });
  });
})();
`;
