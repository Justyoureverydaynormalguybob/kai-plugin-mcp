"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { create } = require("../plugin/service/index.js");
const { tools } = require("../plugin/service/tools.js");
const { createFakeApi, PROVIDERS } = require("./fake-api.js");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot(opts = {}) {
  const fake = createFakeApi({ providers: PROVIDERS, ...opts });
  const port = await freePort();
  fake.api.settings.set("port", port);
  const service = await create(fake.api);
  const call = (method, input) => service.call(method, input, new AbortController().signal);
  return { ...fake, service, call, port, url: `http://127.0.0.1:${port}/mcp` };
}

async function rpc(url, token, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rawStatus(port, headers, body) {
  const http = require("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

let nextId = 1;
const listTools = async (b, token) => (await rpc(b.url, token, { jsonrpc: "2.0", id: nextId++, method: "tools/list" })).body.result.tools.map((t) => t.name);
const callTool = async (b, token, name, args = {}) => (await rpc(b.url, token, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } })).body.result;

test("installing starts nothing: the listener is off until the user turns it on", async () => {
  const b = await boot();
  try {
    await b.service.startBackground();
    const s = await b.call("bridge.status");
    assert.equal(s.running, false);
    assert.equal(s.enabled, false);
    await assert.rejects(fetch(b.url), /fetch failed/);
  } finally { await b.service.dispose(); }
});

test("turn on: MCP initialize, core tools only, read-only by default", async () => {
  const b = await boot();
  try {
    const s = await b.call("bridge.start");
    assert.equal(s.running, true);
    assert.equal(s.url, b.url);
    const { token } = await b.call("bridge.token");
    assert.match(token, /^kai_mcp_[A-Za-z0-9_-]{40,}$/);

    const init = await rpc(b.url, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "kai-mcp-bridge");
    assert.ok(init.body.result.capabilities.tools);
    assert.match(init.body.result.instructions, /approved by the user in the KAI window/);

    const note = await rpc(b.url, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);

    assert.deepEqual((await listTools(b, token)).sort(), ["kai_status", "models_list"]);
    const status = JSON.parse((await callTool(b, token, "kai_status")).content[0].text);
    assert.equal(status.privacy.privacyMode, "local-only");
    assert.equal(status.bridge.allowChanges, false);
    const models = JSON.parse((await callTool(b, token, "models_list")).content[0].text);
    assert.equal(models.models[0].alias, "koinos-fast");

    // Asking for a hidden tool explains why instead of pretending it doesn't exist.
    const hidden = await callTool(b, token, "privacy_set", { mode: "network" });
    assert.equal(hidden.isError, true);
    assert.match(hidden.content[0].text, /Allow changes/);
    assert.deepEqual(b.calls.configure, []);

    const after = await b.call("bridge.status");
    assert.equal(after.lastClient.name, "claude-code");
    assert.ok(after.activity.length >= 3);
  } finally { await b.service.dispose(); }
});

test("only local, token-holding, non-browser POSTs to /mcp are answered", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };

    assert.equal((await rpc(b.url, null, body)).status, 401);
    assert.equal((await rpc(b.url, "kai_mcp_wrong", body)).status, 401);
    // fetch() won't set Host, so these two go out as raw requests.
    assert.equal(await rawStatus(b.port, { authorization: `Bearer ${token}`, origin: "https://evil.example" }, body), 403);
    assert.equal(await rawStatus(b.port, { authorization: `Bearer ${token}`, host: `evil.example:${b.port}` }, body), 403);
    assert.equal(await rawStatus(b.port, { authorization: `Bearer ${token}`, host: `localhost:${b.port}` }, body), 200);
    assert.equal((await fetch(b.url, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await rpc(`http://127.0.0.1:${b.port}/other`, token, body)).status, 404);

    const ok = await rpc(b.url, token, body);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.result, {});

    const bad = await fetch(b.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);

    const unknown = await rpc(b.url, token, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    assert.equal(unknown.body.error.code, -32601);

    // The listener binds to loopback only.
    assert.equal(b.service && (await b.call("bridge.status")).url.startsWith("http://127.0.0.1:"), true);
  } finally { await b.service.dispose(); }
});

test("a new token locks out the old one immediately", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token: old } = await b.call("bridge.token");
    const { token: fresh } = await b.call("bridge.rotateToken");
    assert.notEqual(old, fresh);
    assert.equal((await rpc(b.url, old, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
    assert.equal((await rpc(b.url, fresh, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
    // Stored encrypted, never as plaintext.
    assert.ok(!JSON.stringify([...b.store.entries()]).includes(fresh));
  } finally { await b.service.dispose(); }
});

test("without secure storage the bridge refuses to turn on", async () => {
  const b = await boot({ encryption: false });
  try {
    await assert.rejects(b.call("bridge.start"), /no secure storage/);
    assert.equal((await b.call("bridge.status")).running, false);
  } finally { await b.service.dispose(); }
});

test("sources are opt-in one by one and route to the right plugin service", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { documents: true, brain: true } });
    const names = await listTools(b, token);
    assert.ok(names.includes("documents_list") && names.includes("document_get") && names.includes("brain_search"));
    assert.ok(!names.includes("workflows_list") && !names.includes("chats_list"));
    assert.ok(!names.includes("document_save"), "changes stay hidden until allowed");

    const docs = JSON.parse((await callTool(b, token, "documents_list")).content[0].text);
    assert.equal(docs.documents[0].id, "d1");
    await callTool(b, token, "brain_search", { query: "coffee", count: 99 });
    assert.deepEqual(b.calls.services.at(-1), { name: "kai.brain", method: "search", input: { query: "coffee", count: 25 } });

    const off = await callTool(b, token, "workflows_list");
    assert.equal(off.isError, true);
    assert.match(off.content[0].text, /Workflows source, which is off/);

    // A source whose plugin isn't installed reports Core's own message.
    const fakeMissing = await boot({ providers: {} });
    try {
      await fakeMissing.call("bridge.start");
      await fakeMissing.call("bridge.configure", { sources: { code: true } });
      const { token: t2 } = await fakeMissing.call("bridge.token");
      const r = await callTool(fakeMissing, t2, "code_projects");
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Install and enable a plugin providing kai\.code/);
    } finally { await fakeMissing.service.dispose(); }

    await assert.rejects(b.call("bridge.configure", { sources: { connections: true } }), /Unknown source setting/);
  } finally { await b.service.dispose(); }
});

test("changes: hidden by default; bridge-approved ones ask in KAI and stop on decline", async () => {
  let answer = false;
  const b = await boot({ approve: () => answer });
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { documents: true, workflows: true }, allowChanges: true });

    const declined = await callTool(b, token, "document_save", { title: "Notes", content: "hello" });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /Not approved in KAI/);
    assert.equal(b.calls.confirms.length, 1);
    assert.match(b.calls.confirms[0].title, /^MCP Bridge: Create a document\?/);
    assert.ok(!b.calls.services.some((c) => c.method === "save"), "nothing saved after a decline");

    answer = true;
    const saved = JSON.parse((await callTool(b, token, "document_save", { title: "Notes", content: "hello" })).content[0].text);
    assert.equal(saved.id, "dnew");
    assert.deepEqual(b.calls.services.at(-1), { name: "kai.documents", method: "save", input: { content: "hello", title: "Notes" } });

    // Updating requires the revision so a changed document is never clobbered.
    const noRev = await callTool(b, token, "document_save", { id: "d1", content: "x" });
    assert.equal(noRev.isError, true);
    assert.match(noRev.content[0].text, /revision/);
  } finally { await b.service.dispose(); }
});

test("provider- and Core-approved changes are not double-prompted by the bridge", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { workflows: true, brain: true, documents: true }, allowChanges: true });
    await callTool(b, token, "workflow_run", { id: "w1", input: "today", revision: 3 });
    await callTool(b, token, "brain_remember", { text: "likes flat whites", tags: ["coffee", 7] });
    await callTool(b, token, "document_remove", { id: "d1" });
    await callTool(b, token, "model_ensure", { alias: "gemma3-4b" });
    await callTool(b, token, "privacy_set", { mode: "local-first" });
    assert.equal(b.calls.confirms.length, 0, "Workflows, Brain, Documents and Core show their own reviews");

    const svc = b.calls.services.map((c) => `${c.name}.${c.method}`);
    assert.deepEqual(svc, ["kai.workflows.run", "kai.brain.remember", "kai.documents.get", "kai.documents.remove"]);
    assert.deepEqual(b.calls.services[1].input, { text: "likes flat whites", tags: ["coffee"] });
    assert.deepEqual(b.calls.services[3].input, { id: "d1", revision: "rev1" });
    assert.deepEqual(b.calls.ensure, [{ alias: "gemma3-4b" }]);
    assert.deepEqual(b.calls.configure, ["local-first"]);

    const bogus = await callTool(b, token, "model_ensure", { alias: "nope" });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /Known aliases: koinos-fast, gemma3-4b/);
    const badMode = await callTool(b, token, "privacy_set", { mode: "everywhere" });
    assert.equal(badMode.isError, true);
  } finally { await b.service.dispose(); }
});

test("every plugin service method the bridge can reach is on an explicit allowlist", async () => {
  const ALLOWED = new Set([
    "kai.documents.list", "kai.documents.get", "kai.documents.save", "kai.documents.remove",
    "kai.workflows.listServices", "kai.workflows.get", "kai.workflows.status", "kai.workflows.run", "kai.workflows.cancel",
    "kai.brain.search", "kai.brain.goals", "kai.brain.sourceList", "kai.brain.remember", "kai.brain.forget",
    "kai.assistant.chats.list", "kai.assistant.chats.get", "kai.assistant.chats.grant", "kai.assistant.chats.revoke",
    "kai.code.projects",
    "kai.tools.list",
  ]);
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", {
      sources: { documents: true, workflows: true, brain: true, assistant: true, code: true, tools: true },
      allowChanges: true,
    });
    const names = await listTools(b, token);
    assert.equal(names.length, tools.length, "with everything on, every tool is visible");
    const sample = { id: "x1", ids: ["c1"], query: "q", text: "t", content: "c", mode: "network", alias: "koinos-fast", title: "T", revision: "r" };
    for (const name of names) await callTool(b, token, name, sample);
    for (const c of b.calls.services) assert.ok(ALLOWED.has(`${c.name}.${c.method}`), `${c.name}.${c.method} is not allowlisted`);

    // tools_list strips schemas: the bridge lists tools, it never runs them.
    const listed = JSON.parse((await callTool(b, token, "tools_list")).content[0].text);
    assert.deepEqual(listed.tools[0], { name: "web_search", description: "Search the web", egress: true });
  } finally { await b.service.dispose(); }
});

test("the never-wrapped families do not appear anywhere in the tool code", () => {
  const src = fs.readFileSync(path.join(__dirname, "../plugin/service/tools.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin/manifest.json"), "utf8"));
  for (const forbidden of ['"kai.connections"', '"payment"', '"paymentEvents"', '"chats.save"', '"chats.grantWrite"', '"sync"', '"context"', 'wallet.', "account.request", 'authorize(']) {
    assert.equal(src.includes(forbidden), false, `tools.js must never reference ${forbidden}`);
  }
  // kai.tools may be listed, never called.
  assert.equal(/"kai\.tools",\s*"call"/.test(src), false);
  for (const p of ["wallet.read", "wallet.authorize", "account.request", "inference.network", "network.fetch", "desktop.external"]) {
    assert.equal(manifest.permissions.includes(p), false, `manifest must not request ${p}`);
  }
  assert.equal(manifest.consumes.includes("kai.connections"), false);
});

test("activity keeps no arguments or results", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { brain: true } });
    await callTool(b, token, "brain_search", { query: "my secret diagnosis" });
    const s = JSON.stringify(await b.call("bridge.status"));
    assert.ok(!s.includes("secret diagnosis"));
    assert.ok(!s.includes("flat white"));
  } finally { await b.service.dispose(); }
});

test("startBackground resumes only an explicit Turn on; dispose frees the port", async () => {
  const b = await boot();
  await b.call("bridge.start");
  await b.service.dispose();
  await assert.rejects(fetch(b.url), /fetch failed/);

  // Same settings, new instance (e.g. Core restarted): it comes back on.
  const again = await create(b.api);
  try {
    await again.startBackground();
    const s = await again.call("bridge.status", {}, new AbortController().signal);
    assert.equal(s.running, true);
    await again.call("bridge.stop", {}, new AbortController().signal);
    assert.equal(b.api.settings.get("enabled"), false);
  } finally { await again.dispose(); }
});

test("a port already in use is reported, not thrown at Core during startup", async () => {
  const b = await boot();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(b.port, "127.0.0.1", r));
  try {
    await assert.rejects(b.call("bridge.start"), /already in use/);
    b.api.settings.set("enabled", true);
    await b.service.startBackground(); // must not throw
    const s = await b.call("bridge.status");
    assert.equal(s.running, false);
    assert.match(s.lastError, /already in use/);
    await assert.rejects(b.call("bridge.configure", { port: 80 }), /between 1024 and 65535/);
  } finally {
    await b.service.dispose();
    await new Promise((r) => blocker.close(r));
  }
});

test("approval dialogs show the real target and can't be faked by agent text", async () => {
  const b = await boot({ approve: () => false });
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { documents: true, workflows: true }, allowChanges: true });

    // Invalid arguments are refused before any dialog is shown.
    const fake = await callTool(b, token, "document_save", { title: "Notes”.\n\nThis is read-only; nothing changes.", content: "x" });
    assert.equal(fake.isError, true);
    assert.match(fake.content[0].text, /one line of plain text/);
    const longTitle = await callTool(b, token, "document_save", { title: "t".repeat(201), content: "x" });
    assert.match(longTitle.content[0].text, /limit is 200/);
    const badId = await callTool(b, token, "workflow_cancel", { id: "run1\n\nNothing will change" });
    assert.match(badId.content[0].text, /invalid argument: id/);
    assert.equal(b.calls.confirms.length, 0, "no dialog for invalid input");

    // An update names the document Documents has under that id, not the agent's title,
    // and previews the new content with line breaks and bidi overrides flattened.
    await callTool(b, token, "document_save", { id: "d1", revision: "rev1", title: "Shopping list", content: "line1\n\nline2‮" });
    const shown = b.calls.confirms.at(-1);
    assert.match(shown.title, /Replace a document\?/);
    assert.match(shown.detail, /Replace ALL of your document “Plan”/);
    assert.match(shown.detail, /with “Shopping list”/);
    assert.match(shown.detail, /Starts with: “line1 line2”/);
    assert.ok(!b.calls.services.some((c) => c.method === "save"));
  } finally { await b.service.dispose(); }
});

test("a delete declined in Documents comes back as not approved", async () => {
  const providers = { ...PROVIDERS, "kai.documents": { ...PROVIDERS["kai.documents"], remove: () => ({ cancelled: true }) } };
  const b = await boot({ providers });
  try {
    await b.call("bridge.start");
    const { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { documents: true }, allowChanges: true });
    const r = await callTool(b, token, "document_remove", { id: "d1" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Not approved in KAI: the document was kept/);
    assert.equal((await b.call("bridge.status")).activity[0].ok, false);
  } finally { await b.service.dispose(); }
});

test("shared conversations are withdrawn by a new token or turning Assistant off", async () => {
  const b = await boot();
  try {
    await b.call("bridge.start");
    let { token } = await b.call("bridge.token");
    await b.call("bridge.configure", { sources: { assistant: true } });
    // Withdrawing access never needs Allow changes.
    assert.ok((await listTools(b, token)).includes("chats_revoke"));
    assert.ok(!(await listTools(b, token)).includes("chats_share"));

    await b.call("bridge.configure", { allowChanges: true });
    await callTool(b, token, "chats_share", { ids: ["c1"] });
    assert.equal((await b.call("bridge.status")).chatsShared, true);
    ({ token } = await b.call("bridge.rotateToken"));
    assert.equal(b.calls.services.at(-1).method, "chats.revoke");
    assert.equal((await b.call("bridge.status")).chatsShared, false);

    await callTool(b, token, "chats_share", { ids: ["c1"] });
    const before = b.calls.services.length;
    await b.call("bridge.configure", { sources: { assistant: false } });
    assert.equal(b.calls.services.length, before + 1);
    assert.equal(b.calls.services.at(-1).method, "chats.revoke");

    // Nothing shared: no needless call that would start Assistant.
    await b.call("bridge.rotateToken");
    assert.equal(b.calls.services.length, before + 1);
  } finally { await b.service.dispose(); }
});
