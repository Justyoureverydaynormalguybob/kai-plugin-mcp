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
 *     change is approved by a person in the KAI window (see tools.js). One
 *     approval at a time; a short pause after a decline.
 *   - The token is generated here, stored encrypted with the OS secret store,
 *     and shown only in this plugin's own window.
 *   - Tool arguments and results are never logged or persisted; the activity
 *     list keeps tool name, time, duration and success only, in memory.
 *
 * Provenance: the listener is started OUTSIDE Core's call context. Starting
 * it from the window's Turn on call would otherwise make every later agent
 * request inherit that window as its "initiator" (Node AsyncLocalStorage
 * flows into the server's sockets) — dialogs would claim a person at the
 * bridge page asked, and a reload of the page would abort every call.
 */
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { startMcpServer } = require("./mcp-http");
const { tools, visibleTools, annotations, SOURCES } = require("./tools");

const DEFAULT_PORT = 41111;            // fallback only; each install picks its own
const PORT_RANGE = [42000, 48999];
const ACTIVITY_MAX = 100;
const RESULT_MAX_BYTES = 4 * 1024 * 1024;
const DECLINE_COOLDOWN_MS = 3000;
const SOURCE_KEYS = Object.keys(SOURCES).filter((k) => k !== "core");

const INSTRUCTIONS =
  "You are connected to KAI (KAI Core Beta) on the user's own computer through the MCP Bridge plugin. " +
  "Start with kai_status. Everything you read here goes to your own AI provider, whatever KAI's privacy " +
  "mode says, so read only what the task needs. Changes are approved by the user in the KAI window; if a " +
  "change comes back not approved, tell the user and do not retry it unasked.";

function create(api) {
  if (api.version !== 1) throw Error("MCP Bridge requires KAI Foundation API v1");
  // A function that runs code in the async context of create(), i.e. outside
  // whatever renderer call later presses Turn on (see the header comment).
  const outside = typeof AsyncLocalStorage.snapshot === "function" ? AsyncLocalStorage.snapshot() : (fn, ...a) => fn(...a);
  let closed = false;
  let server = null;
  let starting = null;
  let lastError = null;
  let lastClient = null;
  let approving = false;
  let declinedAt = 0;
  const activity = [];
  const runs = new Set(); // workflow runs this bridge started (in memory only)

  const alive = (signal) => {
    if (closed) throw Error("MCP Bridge is closed");
    api.signal.throwIfAborted();
    signal?.throwIfAborted();
  };

  // ----- settings -----
  const validPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
  const port = () => {
    const p = api.settings.get("port", null);
    if (validPort(p)) return p;
    // A fixed, well-known port invites squatting by another local program
    // while the bridge is off. Pick one per install and keep it.
    const picked = crypto.randomInt(PORT_RANGE[0], PORT_RANGE[1] + 1);
    api.settings.set("port", picked);
    return picked;
  };
  const allowChanges = () => api.settings.get("allowChanges", false) === true;
  const sources = () => {
    const saved = api.settings.get("sources", {}) || {};
    return Object.fromEntries(SOURCE_KEYS.map((k) => [k, saved[k] === true]));
  };

  // ----- token: random, encrypted at rest with the OS secret store -----
  let tokenCache = null;
  function secureStorage() {
    if (!api.secrets.isEncryptionAvailable()) return false;
    // Electron's Linux fallback "basic_text" encrypts with a hard-coded key.
    try { if (api.secrets.getSelectedStorageBackend?.() === "basic_text") return false; } catch { /* not reported */ }
    return true;
  }
  function requireEncryption() {
    if (!secureStorage()) {
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

  async function approve(title, detail, signal) {
    if (approving) throw Error("Another change is already waiting for the user's approval in KAI. Wait for it.");
    if (Date.now() - declinedAt < DECLINE_COOLDOWN_MS) throw Error("The user just declined a change. Ask them before trying anything else.");
    approving = true;
    try {
      const ok = await api.desktop.confirm(
        `MCP Bridge: ${title}`,
        `An AI agent connected through MCP Bridge asks for this:\n\n${detail}`,
        signal,
      );
      if (!ok) {
        declinedAt = Date.now();
        throw Error("Not approved in KAI. The user declined, or the MCP Bridge page wasn't open in KAI (approvals need it). Tell the user; do not retry unasked.");
      }
    } finally {
      approving = false;
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
        ? `Unknown tool: ${String(name).slice(0, 64)}`
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
      runs,
      sources: sources(),
      allowChanges: allowChanges(),
      alive: () => { alive(signal); if (!server) throw Error("MCP Bridge was turned off"); },
      call: (service, method, input) => api.services.call(service, method, input, { signal }),
    };
    try {
      alive(signal);
      let result;
      if (tool.prepare) {
        const prepared = await tool.prepare(ctx, args); // validates and looks up first
        alive(signal);
        if (tool.approval === "bridge") await approve(prepared.title, prepared.detail, signal);
        ctx.alive();
        result = await tool.run(ctx, prepared.input);
      } else {
        result = await tool.handler(ctx, args);
      }
      if (name === "chats_share") api.settings.set("chatsShared", true);
      if (name === "chats_revoke") api.settings.set("chatsShared", false);
      const text = JSON.stringify(result ?? null, null, 2);
      if (Buffer.byteLength(text) > RESULT_MAX_BYTES) throw Error("The result is too large to return (over 4 MB). Ask for something narrower.");
      record({ at: started, tool: name, ok: true, ms: Date.now() - started });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      record({ at: started, tool: name, ok: false, ms: Date.now() - started, error: "failed" });
      return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
    }
  }

  // Conversations shared with chats_share are granted to this plugin, not to
  // a token. Withdraw them whenever agents are cut off (a new token, or the
  // Assistant source turned off), so old access never outlives that.
  async function revokeSharedChats() {
    if (api.settings.get("chatsShared", false) !== true) return;
    try {
      await outside(() => api.services.call("kai.assistant", "chats.revoke", {}, { signal: api.signal }));
      api.settings.set("chatsShared", false);
    } catch (error) {
      lastError = `Could not withdraw shared Assistant conversations: ${error?.message ?? error}. Withdraw them in Assistant Settings.`;
      api.log("warn", lastError);
    }
  }

  // ----- listener lifecycle -----
  async function start() {
    alive();
    if (server) return status();
    if (starting) { await starting; return status(); }
    starting = outside(async () => {
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
          onError: (error) => api.log("warn", `MCP Bridge listener: ${error?.code || error?.message || error}`),
        });
        lastError = null;
        if (closed) { await server.close(); server = null; }
        else api.log("info", `MCP Bridge listening on 127.0.0.1:${server.port}`);
      } catch (error) {
        server = null;
        if (error?.code === "EADDRINUSE") {
          // Whatever holds the port may have collected the token from a
          // client that tried to connect. Never reuse it.
          try { newToken(); await revokeSharedChats(); } catch { /* reported below */ }
          lastError = `Port ${port()} is already in use by another program. For safety the access token was replaced; choose another port, then give your agents the new token.`;
        } else {
          lastError = `Could not start: ${error?.message ?? error}`;
        }
        api.log("warn", lastError);
        throw Error(lastError);
      }
    });
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
    try { encryption = secureStorage(); } catch { /* reported as false */ }
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
      chatsShared: api.settings.get("chatsShared", false) === true,
      encryption,
      lastError,
      lastClient,
      activity: activity.slice(0, 30),
    };
  }

  // ----- the bridge window's own methods -----
  async function configure(input = {}) {
    if (input.port !== undefined) {
      if (!validPort(input.port)) throw Error("Choose a port between 1024 and 65535.");
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
      if (next.assistant !== true) await revokeSharedChats();
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
        case "bridge.token":
          return { token: token() };
        case "bridge.rotateToken":
          newToken(); // existing clients stop working at once
          await revokeSharedChats();
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

module.exports = { create, DEFAULT_PORT, PORT_RANGE };
