"use strict";
/*
 * MCP Bridge — native service.
 *
 * Lets AI agents on this computer (Claude Code, Claude Desktop, Cursor, any
 * MCP client) use KAI through the Model Context Protocol.
 *
 * Consent model:
 *   - Installing the plugin starts nothing. The local endpoint runs only after
 *     the user presses Turn on, and startBackground() resumes only that
 *     explicit choice.
 *   - Read access to other plugins is off per source until ticked.
 *   - Changes are hidden until "Allow changes" is ticked, and even then every
 *     change is approved by a person in the KAI window (see tools.js).
 *   - The token is generated here, stored encrypted with the OS secret store,
 *     and shown only in this plugin's own window.
 *   - Tool arguments and results are never logged or persisted; the activity
 *     list keeps tool name, time, duration and success only, in memory.
 */
const crypto = require("node:crypto");
const { startMcpServer } = require("./mcp-http");
const { tools, visibleTools, annotations, SOURCES } = require("./tools");

const DEFAULT_PORT = 41111;
const ACTIVITY_MAX = 100;
const SOURCE_KEYS = Object.keys(SOURCES).filter((k) => k !== "core");

const INSTRUCTIONS =
  "You are connected to KAI (KAI Core Beta) on the user's own computer through the MCP Bridge plugin. " +
  "Start with kai_status. Changes are approved by the user in the KAI window: if a change comes back " +
  "'not approved', tell the user and do not retry it unasked. For local model inference, use KAI's " +
  "OpenAI-compatible API at http://127.0.0.1:41100/v1 directly.";

function create(api) {
  if (api.version !== 1) throw Error("MCP Bridge requires KAI Foundation API v1");
  let closed = false;
  let server = null;
  let starting = null;
  let lastError = null;
  let lastClient = null;
  const activity = [];

  const alive = (signal) => {
    if (closed) throw Error("MCP Bridge is closed");
    api.signal.throwIfAborted();
    signal?.throwIfAborted();
  };

  // ----- settings -----
  const port = () => {
    const p = api.settings.get("port", DEFAULT_PORT);
    return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
  };
  const allowChanges = () => api.settings.get("allowChanges", false) === true;
  const sources = () => {
    const saved = api.settings.get("sources", {}) || {};
    return Object.fromEntries(SOURCE_KEYS.map((k) => [k, saved[k] === true]));
  };

  // ----- token: random, encrypted at rest with the OS secret store -----
  let tokenCache = null;
  function requireEncryption() {
    if (!api.secrets.isEncryptionAvailable()) {
      throw Error("This computer has no secure storage available for the bridge's access token, so MCP Bridge cannot be turned on.");
    }
  }
  function newToken() {
    requireEncryption();
    const token = "kai_mcp_" + crypto.randomBytes(32).toString("base64url");
    api.settings.set("token", Buffer.from(api.secrets.encryptString(token)).toString("base64"));
    tokenCache = token;
    return token;
  }
  function token() {
    if (tokenCache) return tokenCache;
    const saved = api.settings.get("token", null);
    if (typeof saved !== "string" || !saved) return null;
    try {
      tokenCache = api.secrets.decryptString(Buffer.from(saved, "base64"));
      return tokenCache;
    } catch {
      return null; // unreadable (e.g. OS keychain reset) — a new one is made on Turn on
    }
  }

  // ----- tool execution -----
  function record(entry) {
    activity.unshift(entry);
    if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
  }

  async function approve(title, detail) {
    const ok = await api.desktop.confirm(`MCP Bridge: ${title}`, `An AI agent connected through MCP Bridge wants to do this:\n\n${detail}`);
    if (!ok) {
      throw Error("Not approved in KAI. The user declined, or the KAI window was hidden (approvals need it open). Tell the user; do not retry unasked.");
    }
  }

  function listTools() {
    return visibleTools({ sources: sources(), allowChanges: allowChanges() }).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: annotations(t),
    }));
  }

  async function callTool(name, args, requestSignal) {
    const started = Date.now();
    const visible = visibleTools({ sources: sources(), allowChanges: allowChanges() });
    const tool = visible.find((t) => t.name === name);
    if (!tool) {
      const known = tools.find((t) => t.name === name);
      const why = !known
        ? `Unknown tool: ${name}`
        : known.mutating && !allowChanges()
          ? `"${name}" makes changes, and the user has not ticked "Allow changes" in MCP Bridge.`
          : `"${name}" needs the ${SOURCES[known.source].label} source, which is off in MCP Bridge.`;
      record({ at: started, tool: String(name).slice(0, 64), ok: false, ms: 0, error: "unavailable" });
      return { content: [{ type: "text", text: why }], isError: true };
    }
    const signal = AbortSignal.any([api.signal, requestSignal]);
    const ctx = {
      api,
      signal,
      sources: sources(),
      allowChanges: allowChanges(),
      call: (service, method, input) => api.services.call(service, method, input, { signal }),
    };
    try {
      alive(signal);
      if (tool.approval === "bridge") {
        const { title, detail } = tool.confirm(args);
        await approve(title, detail);
        alive(signal);
      }
      const result = await tool.handler(ctx, args);
      record({ at: started, tool: name, ok: true, ms: Date.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (error) {
      record({ at: started, tool: name, ok: false, ms: Date.now() - started, error: "failed" });
      return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
    }
  }

  // ----- listener lifecycle -----
  async function start() {
    alive();
    if (server) return status();
    if (starting) { await starting; return status(); }
    starting = (async () => {
      if (!token()) newToken();
      try {
        server = await startMcpServer({
          port: port(),
          getToken: token,
          info: { name: "kai-mcp-bridge", title: "KAI MCP Bridge", version: api.plugin.version },
          instructions: INSTRUCTIONS,
          listTools,
          callTool,
          onClient: (client) => { lastClient = { ...client, at: Date.now() }; },
        });
        lastError = null;
        if (closed) { await server.close(); server = null; }
        else api.log("info", `MCP Bridge listening on 127.0.0.1:${server.port}`);
      } catch (error) {
        server = null;
        lastError = error?.code === "EADDRINUSE"
          ? `Port ${port()} is already in use on this computer. Choose another port.`
          : `Could not start: ${error?.message ?? error}`;
        api.log("warn", lastError);
        throw Error(lastError);
      }
    })();
    try { await starting; } finally { starting = null; }
    return status();
  }

  async function stop() {
    if (starting) await starting.catch(() => {});
    const s = server;
    server = null;
    if (s) { await s.close(); api.log("info", "MCP Bridge stopped"); }
  }

  function status() {
    const p = server?.port ?? port();
    let encryption = false;
    try { encryption = api.secrets.isEncryptionAvailable(); } catch { /* reported as false */ }
    return {
      version: api.plugin.version,
      running: !!server,
      enabled: api.settings.get("enabled", false) === true,
      port: p,
      url: `http://127.0.0.1:${p}/mcp`,
      allowChanges: allowChanges(),
      sources: sources(),
      sourceLabels: Object.fromEntries(SOURCE_KEYS.map((k) => [k, SOURCES[k].label])),
      toolCount: visibleTools({ sources: sources(), allowChanges: allowChanges() }).length,
      hasToken: !!token(),
      encryption,
      lastError,
      lastClient,
      activity: activity.slice(0, 30),
    };
  }

  // ----- the bridge window's own methods -----
  async function configure(input = {}) {
    if (input.port !== undefined) {
      if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw Error("Choose a port between 1024 and 65535.");
      const changed = input.port !== port();
      api.settings.set("port", input.port);
      if (changed && server) { await stop(); await start(); }
    }
    if (input.allowChanges !== undefined) {
      if (typeof input.allowChanges !== "boolean") throw Error("allowChanges must be true or false");
      api.settings.set("allowChanges", input.allowChanges);
    }
    if (input.sources !== undefined) {
      if (!input.sources || typeof input.sources !== "object" || Array.isArray(input.sources)) throw Error("sources must be an object");
      const next = sources();
      for (const [key, value] of Object.entries(input.sources)) {
        if (!SOURCE_KEYS.includes(key) || typeof value !== "boolean") throw Error(`Unknown source setting: ${key}`);
        next[key] = value;
      }
      api.settings.set("sources", next);
    }
    return status();
  }

  function dispose() {
    if (closed) return;
    closed = true;
    api.signal.removeEventListener("abort", dispose);
    return stop();
  }
  api.signal.addEventListener("abort", dispose, { once: true });

  return {
    async call(method, input, signal) {
      alive(signal);
      switch (method) {
        case "bridge.status":
          return status();
        case "bridge.start":
          api.settings.set("enabled", true);
          return start();
        case "bridge.stop":
          api.settings.set("enabled", false);
          await stop();
          return status();
        case "bridge.configure":
          return configure(input || {});
        case "bridge.token": {
          const t = token();
          return { token: t };
        }
        case "bridge.rotateToken":
          newToken(); // existing clients stop working at once
          return { ...status(), token: token() };
        case "bridge.clearActivity":
          activity.length = 0;
          return status();
        default:
          throw Error("Unknown MCP Bridge operation");
      }
    },
    // Resume only what the user explicitly switched on. A failure here must
    // not take the plugin down — it is shown in the bridge window instead.
    async startBackground() {
      alive();
      if (api.settings.get("enabled", false) === true) await start().catch(() => {});
    },
    dispose,
  };
}

module.exports = { create, DEFAULT_PORT };
