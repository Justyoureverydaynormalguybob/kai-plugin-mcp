"use strict";
// A fake KAI Foundation API v1 (docs/foundation/api-v1.d.ts in kai-core),
// enough to run the bridge's native service outside Electron. Model shapes
// mirror a live KAI Core 0.7.17 node.

function createFakeApi({ encryption = true, approve = true, providers = {} } = {}) {
  const controller = new AbortController();
  const store = new Map();
  const calls = { services: [], confirms: [], ensure: [], configure: [], logs: [] };
  let privacyMode = "local-only";

  const api = {
    version: 1,
    plugin: Object.freeze({ id: "community.mcp-bridge", version: "0.1.0", root: "/fake/root", dataDir: "/fake/data" }),
    paths: { protected: ["/fake/profile"] },
    signal: controller.signal,
    settings: {
      get: (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: (key, value) => { store.set(key, structuredClone(value)); return value; },
    },
    locale: { get: () => ({ language: "en", direction: "ltr", selected: true, languages: [] }), onChange: () => () => {} },
    models: {
      list: () => [
        { alias: "koinos-fast", label: "Qwen 2.5 1.5B", status: "ready", sizeBytes: 986048768, downloadSizeBytes: 986048768, diskBytes: 986048768 },
        { alias: "gemma3-4b", label: "Gemma 3 4B", status: "absent", sizeBytes: 2489758112, downloadSizeBytes: 3341009216, diskBytes: 0 },
      ],
      ensure: async (input) => { calls.ensure.push(input); return { queued: true, alias: input.alias }; },
      request: async () => { throw Error("not used"); },
      chat: async () => { throw Error("not used"); },
      embeddings: async () => { throw Error("not used"); },
    },
    runtime: { status: () => ({ activeAlias: null, loading: false, loadingAlias: null, loadingStage: null, inference: { activeAlias: null, queued: 0 } }) },
    network: {
      status: () => ({ privacyMode }),
      configure: async ({ privacyMode: m }) => { calls.configure.push(m); privacyMode = m; return { privacyMode }; },
      models: async () => [],
      fetch: async () => { throw Error("not used"); },
    },
    secrets: {
      isEncryptionAvailable: () => encryption,
      getSelectedStorageBackend: () => "fake",
      encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
      decryptString: (b) => {
        const s = Buffer.from(b).toString("utf8");
        if (!s.startsWith("enc:")) throw Error("bad ciphertext");
        return s.slice(4);
      },
    },
    desktop: {
      confirm: async (title, detail) => { calls.confirms.push({ title, detail }); return typeof approve === "function" ? approve(title, detail) : approve; },
      isVisible: () => true,
    },
    services: {
      call: async (name, method, input, options) => {
        calls.services.push({ name, method, input });
        options?.signal?.throwIfAborted();
        const provider = providers[name];
        if (!provider) throw Error(`Install and enable a plugin providing ${name}`);
        if (!provider[method]) throw Error(`Service method unavailable: ${name}.${method}`);
        return provider[method](input);
      },
    },
    log: (level, message) => calls.logs.push({ level, message: String(message) }),
  };
  return { api, calls, store, abort: () => controller.abort(Error("Plugin stopped")) };
}

// Canned providers shaped like the real plugins' services.
const PROVIDERS = {
  "kai.documents": {
    list: () => ({ documents: [{ id: "d1", title: "Plan", updatedAt: "2026-11-02T10:00:00.000Z", words: 3, preview: "a b c" }], errors: [] }),
    get: ({ id }) => ({ id, title: "Plan", content: "a b c", revision: "rev1" }),
    save: (input) => ({ id: input.id || "dnew", title: input.title || "Untitled", content: input.content, revision: "rev2" }),
    remove: ({ id }) => ({ removed: true, id }),
  },
  "kai.workflows": {
    listServices: () => [{ id: "w1", name: "Morning brief", draft: false, revision: 3 }],
    // Shapes as in kai-plugin-workflows: graphs carry step config (incl. HTTP
    // headers), run records carry the spec and every step's input/output, and
    // the no-id status is the whole store plus connections and Brain sources.
    get: ({ id }) => ({ id, name: "Morning brief", revision: 3, draft: false, enabled: true, schedule: { kind: "daily", hour: 7 },
      graph: { nodes: [{ id: "n1", type: "http_request", label: "Fetch", config: { url: "https://api.example", headers: { authorization: "Bearer SECRET-HEADER" } } }] } }),
    status: (input) => (input.id
      ? { id: input.id, workflowId: "w1", name: "Morning brief", status: "done", startedAt: 1, finishedAt: 2, spec: { secret: "SPEC-SECRET" }, steps: [{ output: "STEP-PRIVATE-EMAIL" }], previous: "Final summary" }
      : { workflows: [], runs: [{ steps: [{ output: "STEP-PRIVATE-EMAIL" }] }], connections: [{ account: "me@example.com" }], sources: [] }),
    run: () => ({ id: "run1" }),
    cancel: () => ({ cancelled: true }),
  },
  "kai.brain": {
    search: () => [{ id: "n1", title: "Coffee", text: "flat white", score: 1 }],
    goals: () => [],
    sourceList: () => [],
    remember: (input) => ({ id: "n2", ...input }),
    forget: ({ id }) => ({ forgotten: true, id }),
  },
  "kai.assistant": {
    "chats.list": () => [{ id: "c1", title: "Hello" }],
    "chats.get": ({ id }) => ({ id, title: "Hello", messages: [] }),
    "chats.grant": ({ ids }) => ({ ids }),
    "chats.revoke": () => ({ revoked: true }),
  },
  "kai.code": { projects: () => ({ projects: [{ id: "p1", name: "site", missing: false }] }) },
  "kai.tools": { list: () => ({ tools: [{ name: "web_search", description: "Search the web", inputSchema: { type: "object" }, egress: true }] }) },
};

module.exports = { createFakeApi, PROVIDERS };
