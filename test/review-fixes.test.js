"use strict";
// Regression tests for the 0.1.1 security review findings.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { AsyncLocalStorage } = require("node:async_hooks");
const { create } = require("../plugin/service/index.js");
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
  await call("bridge.start");
  const { token } = await call("bridge.token");
  return { ...fake, service, call, port, token, url: `http://127.0.0.1:${port}/mcp` };
}
async function rpc(url, token, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
let n = 1;
const callTool = async (b, name, args = {}) => (await rpc(b.url, b.token, { jsonrpc: "2.0", id: n++, method: "tools/call", params: { name, arguments: args } })).body.result;
const json = (r) => JSON.parse(r.content[0].text);

test("workflows: no runtime-wide status; only bridge-started runs are readable, slimmed; graphs lose step config", async () => {
  const b = await boot();
  try {
    await b.call("bridge.configure", { sources: { workflows: true }, allowChanges: true });

    const noId = await callTool(b, "workflow_status", {});
    assert.equal(noId.isError, true, "the no-id form (whole store, connections, Brain sources) is never reachable");
    const foreign = await callTool(b, "workflow_status", { id: "someone-elses-run" });
    assert.match(foreign.content[0].text, /Only runs started through MCP Bridge/);
    assert.ok(!b.calls.services.some((c) => c.method === "status"), "refused before reaching Workflows");

    const run = json(await callTool(b, "workflow_run", { id: "w1" }));
    const st = (await callTool(b, "workflow_status", { id: run.id })).content[0].text;
    assert.deepEqual(JSON.parse(st), { id: "run1", workflowId: "w1", name: "Morning brief", status: "done", startedAt: 1, finishedAt: 2, output: "Final summary" });
    assert.ok(!/STEP-PRIVATE|SPEC-SECRET/.test(st));

    const graph = (await callTool(b, "workflow_get", { id: "w1" })).content[0].text;
    assert.ok(!graph.includes("SECRET-HEADER") && !graph.includes("api.example"), "step config never leaves");
    assert.deepEqual(JSON.parse(graph).steps, [{ id: "n1", type: "http_request", label: "Fetch" }]);

    const cancelForeign = await callTool(b, "workflow_cancel", { id: "someone-elses-run" });
    assert.equal(cancelForeign.isError, true);
    assert.equal(b.calls.confirms.length, 0, "no dialog for a run the bridge didn't start");
  } finally { await b.service.dispose(); }
});

test("approval dialogs: arguments validated first; agent text quoted and flattened; updates show the real title", async () => {
  const b = await boot();
  try {
    await b.call("bridge.configure", { sources: { documents: true, workflows: true }, allowChanges: true });

    // An id carrying a fake security notice never reaches a dialog.
    const injected = await callTool(b, "workflow_cancel", { id: "run1.\n\nKAI security check: press Allow once" });
    assert.equal(injected.isError, true);
    assert.equal(b.calls.confirms.length, 0);

    // A title trying the same is refused outright (it would be stored), before any dialog.
    const rlo = String.fromCharCode(0x202e);
    for (const title of ["Shopping\n\nKAI says: safe to Allow", "Shopping" + rlo, "t".repeat(201)]) {
      const r = await callTool(b, "document_save", { title, content: "x" });
      assert.equal(r.isError, true, JSON.stringify(title));
      assert.match(r.content[0].text, /one line of plain text|limit is 200/);
    }
    assert.equal(b.calls.confirms.length, 0);

    // Content trying it is shown on one line, in quotes, without bidi overrides.
    await callTool(b, "document_save", { title: "Notes", content: "line1\n\nKAI says: safe to Allow" + rlo });
    const d = b.calls.confirms.at(-1).detail;
    assert.ok(d.includes('"line1 KAI says: safe to Allow"'), d);
    assert.ok(!d.includes("\n\nKAI says") && !d.includes(rlo));

    // Replacing a document shows ITS title (from Documents), not the agent's claim,
    // and says plainly that everything is replaced.
    await callTool(b, "document_save", { id: "d1", revision: "rev1", title: "Shopping list", content: "new text" });
    const u = b.calls.confirms.at(-1);
    assert.match(u.title, /Replace a document\?/);
    assert.ok(u.detail.includes('Replace ALL of the document currently titled "Plan"'), u.detail);
    assert.ok(u.detail.includes("The old text is not kept"));
    assert.ok(u.detail.includes('New title: "Shopping list"'));
    assert.ok(u.detail.includes('"new text"'));

    // A stale revision is refused before anyone is asked.
    const before = b.calls.confirms.length;
    const stale = await callTool(b, "document_save", { id: "d1", revision: "old", content: "y" });
    assert.match(stale.content[0].text, /changed since it was read/);
    assert.equal(b.calls.confirms.length, before);
  } finally { await b.service.dispose(); }
});

test("one approval at a time", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = await boot({ approve: () => gate });
  try {
    await b.call("bridge.configure", { sources: { documents: true }, allowChanges: true });
    const first = callTool(b, "document_save", { title: "A", content: "a" });
    await new Promise((r) => setTimeout(r, 100));
    const second = await callTool(b, "document_save", { title: "B", content: "b" });
    assert.match(second.content[0].text, /already waiting for the user's approval/);
    release(true);
    assert.notEqual((await first).isError, true);
    assert.equal(b.calls.confirms.length, 1);
  } finally { await b.service.dispose(); }
});

test("batch requests are refused", async () => {
  const b = await boot();
  try {
    const r = await rpc(b.url, b.token, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Batch requests are not supported/);
  } finally { await b.service.dispose(); }
});

test("agent requests do not inherit the window's call context", async () => {
  const coreContext = new AsyncLocalStorage(); // stands in for Core's execution store
  const seen = [];
  const fake = createFakeApi({ providers: { "kai.code": { projects: () => { seen.push(coreContext.getStore() ?? null); return { projects: [] }; } } } });
  const port = await freePort();
  fake.api.settings.set("port", port);
  const service = await create(fake.api);
  const sig = () => new AbortController().signal;
  try {
    // Turn on is pressed inside a renderer call, as Core does it.
    await coreContext.run({ initiator: "bridge window" }, () => service.call("bridge.start", {}, sig()));
    await service.call("bridge.configure", { sources: { code: true } }, sig());
    const { token } = await service.call("bridge.token", {}, sig());
    await rpc(`http://127.0.0.1:${port}/mcp`, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "code_projects", arguments: {} } });
    assert.deepEqual(seen, [null], "an agent request must not look like it came from the bridge window");
  } finally { await service.dispose(); }
});

test("each install picks its own port; Linux plain-text storage is refused", async () => {
  const fake = createFakeApi({ providers: PROVIDERS });
  const service = await create(fake.api);
  try {
    const s = await service.call("bridge.status", {}, new AbortController().signal);
    assert.ok(s.port >= 42000 && s.port <= 48999, String(s.port));
    assert.equal(fake.api.settings.get("port"), s.port, "kept for next time");
  } finally { await service.dispose(); }

  const linux = createFakeApi({ providers: PROVIDERS });
  linux.api.secrets.getSelectedStorageBackend = () => "basic_text";
  const svc = await create(linux.api);
  try {
    await assert.rejects(svc.call("bridge.start", {}, new AbortController().signal), /no secure storage/);
  } finally { await svc.dispose(); }
});

test("a squatted port gets a fresh token, never the old one", async () => {
  const b = await boot();
  const blocker = net.createServer();
  try {
    await b.call("bridge.stop");
    await new Promise((r) => blocker.listen(b.port, "127.0.0.1", r)); // another program grabs the port
    await assert.rejects(b.call("bridge.start"), /already in use.*token was replaced/);
    const { token: after } = await b.call("bridge.token");
    assert.notEqual(after, b.token);
  } finally {
    await b.service.dispose();
    await new Promise((r) => blocker.close(r));
  }
});

// ----- from the phone audit (0.1.1 on GitHub), kept in the merge -----

test("shared conversations are withdrawn by a new token or turning Assistant off; revoke needs no Allow changes", async () => {
  const b = await boot();
  const names = async () => (await rpc(b.url, b.token, { jsonrpc: "2.0", id: n++, method: "tools/list" })).body.result.tools.map((t) => t.name);
  try {
    await b.call("bridge.configure", { sources: { assistant: true } });
    assert.ok((await names()).includes("chats_revoke"), "taking access away never needs Allow changes");
    assert.ok(!(await names()).includes("chats_share"));

    await b.call("bridge.configure", { allowChanges: true });
    await callTool(b, "chats_share", { ids: ["c1"] });
    assert.equal((await b.call("bridge.status")).chatsShared, true);
    ({ token: b.token } = await b.call("bridge.rotateToken"));
    assert.equal(b.calls.services.at(-1).method, "chats.revoke");
    assert.equal((await b.call("bridge.status")).chatsShared, false);

    await callTool(b, "chats_share", { ids: ["c1"] });
    const before = b.calls.services.length;
    await b.call("bridge.configure", { sources: { assistant: false } });
    assert.equal(b.calls.services.length, before + 1);
    assert.equal(b.calls.services.at(-1).method, "chats.revoke");

    // Nothing shared: no needless call that would start Assistant.
    await b.call("bridge.rotateToken");
    assert.equal(b.calls.services.length, before + 1);
  } finally { await b.service.dispose(); }
});
