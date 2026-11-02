"use strict";
(function () {
  const I = window.MCPBridgeI18n;
  const $ = (id) => document.getElementById(id);
  const SOURCE_ORDER = ["documents", "workflows", "brain", "assistant", "code", "tools"];
  const PLUGIN_NAMES = { documents: "Documents", workflows: "Workflows", brain: "Brain", assistant: "KAI Assistant", code: "Koinos Code", tools: "KAI Tools" };
  let state = null, token = null, showToken = false, busy = false, timer = null;

  const call = (method, input) => window.kai.call(method, input || {});

  function showError(message) {
    const el = $("error");
    el.hidden = !message;
    el.textContent = message || "";
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    try { showError(""); await fn(); }
    catch (e) { showError(e && e.message ? e.message : String(e)); }
    finally { busy = false; await refresh(); }
  }

  function configText(url, tok) {
    const t = tok || "<token>";
    $("cmd-claude").value = `claude mcp add --transport http kai ${url} --header "Authorization: Bearer ${t}"`;
    $("cmd-json").value = JSON.stringify({ mcpServers: { kai: { type: "http", url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);
  }

  async function copy(text, button) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back below */ }
    if (!ok) {
      const area = document.createElement("textarea");
      area.value = text; document.body.appendChild(area); area.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      area.remove();
    }
    if (ok) {
      const label = button.textContent;
      button.textContent = I.t("copied");
      setTimeout(() => { button.textContent = label; }, 1200);
    }
  }

  function renderSources() {
    const box = $("sources");
    box.replaceChildren();
    for (const key of SOURCE_ORDER) {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!state.sources[key];
      input.addEventListener("change", () => act(() => call("bridge.configure", { sources: { [key]: input.checked } })));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = I.t(`src.${key}`);
      const small = document.createElement("small");
      small.textContent = `${I.t(`src.${key}.hint`)} ${I.t("needPlugin", { name: PLUGIN_NAMES[key] })}`;
      text.append(strong, small);
      label.append(input, text);
      box.append(label);
    }
  }

  function renderActivity() {
    const list = $("activity");
    list.replaceChildren();
    const fmt = new Intl.DateTimeFormat(I.language, { timeStyle: "medium" });
    if (!state.activity.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = I.t("noActivity");
      list.append(li);
    }
    for (const a of state.activity) {
      const li = document.createElement("li");
      li.className = a.ok ? "" : "bad";
      li.textContent = `${fmt.format(new Date(a.at))}  ${a.tool}  ${a.ok ? `${a.ms} ms` : I.t("failed")}`;
      list.append(li);
    }
    $("client").textContent = state.lastClient
      ? I.t("lastClient", { name: `${state.lastClient.name} ${state.lastClient.version}`.trim(), time: fmt.format(new Date(state.lastClient.at)) })
      : "";
  }

  function render() {
    if (!state) return;
    const pill = $("pill");
    const problem = !state.running && state.lastError;
    pill.textContent = I.t(state.running ? "pillOn" : problem ? "pillError" : "pillOff");
    pill.className = `pill ${state.running ? "pill-on" : problem ? "pill-error" : "pill-off"}`;
    $("state-text").textContent = I.t(state.running ? "stateOn" : "stateOff");
    $("toggle").textContent = I.t(state.running ? "turnOff" : "turnOn");
    if (problem) showError(state.lastError);

    $("connect").hidden = !state.running;
    $("url").value = state.url;
    $("token").type = showToken ? "text" : "password";
    $("token").value = token || "";
    $("show-token").textContent = I.t(showToken ? "hide" : "show");
    configText(state.url, showToken ? token : null);

    if (document.activeElement !== $("port")) $("port").value = state.port;
    $("allow-changes").checked = state.allowChanges;
    $("tool-count").textContent = I.t("toolCount", { n: state.toolCount });
    renderSources();
    renderActivity();
  }

  async function refresh() {
    try {
      state = await call("bridge.status");
      if (state.running && !token) token = (await call("bridge.token")).token;
      render();
    } catch (e) { showError(e && e.message ? e.message : String(e)); }
  }

  $("toggle").addEventListener("click", () => act(async () => {
    if (state && state.running) await call("bridge.stop");
    else { await call("bridge.start"); token = (await call("bridge.token")).token; }
  }));
  $("show-token").addEventListener("click", () => { showToken = !showToken; render(); });
  $("copy-token").addEventListener("click", (e) => token && copy(token, e.currentTarget));
  // Copy buttons always copy the real token, even while it is hidden on screen.
  $("copy-claude").addEventListener("click", (e) => copy(`claude mcp add --transport http kai ${state.url} --header "Authorization: Bearer ${token}"`, e.currentTarget));
  $("copy-json").addEventListener("click", (e) => copy(JSON.stringify({ mcpServers: { kai: { type: "http", url: state.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2), e.currentTarget));
  $("rotate").addEventListener("click", () => act(async () => {
    const ok = window.kai.dialogs
      ? await window.kai.dialogs.confirm(I.t("rotateConfirm"), { detail: I.t("rotateDetail") })
      : true;
    if (ok) token = (await call("bridge.rotateToken")).token;
  }));
  $("allow-changes").addEventListener("change", (e) => act(() => call("bridge.configure", { allowChanges: e.target.checked })));
  $("save-port").addEventListener("click", () => act(() => call("bridge.configure", { port: Number($("port").value) })));
  $("clear").addEventListener("click", () => act(() => call("bridge.clearActivity")));

  function poll() {
    clearInterval(timer);
    if (document.visibilityState === "visible") timer = setInterval(refresh, 2000);
  }
  document.addEventListener("visibilitychange", () => { poll(); if (document.visibilityState === "visible") refresh(); });

  // Follow Core's language. Subscribe before reading so a late read never
  // overwrites a newer change.
  let revision = 0;
  const applyLanguage = (s) => {
    I.set(s && s.language);
    document.documentElement.lang = I.language;
    document.documentElement.dir = (s && s.direction) || "ltr";
    I.apply();
    render();
  };
  const locale = window.kai.locale;
  if (locale && locale.onChange) {
    const unsubscribe = locale.onChange((s) => { revision++; applyLanguage(s); });
    window.addEventListener("pagehide", unsubscribe, { once: true });
    const initial = revision;
    locale.get().then((s) => { if (revision === initial) applyLanguage(s); }).catch(() => applyLanguage(null));
  } else applyLanguage(null);

  refresh();
  poll();
})();
