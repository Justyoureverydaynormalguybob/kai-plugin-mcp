"use strict";
/*
 * A minimal, dependency-free MCP server over Streamable HTTP (JSON responses,
 * stateless — no sessions, no server-initiated streams). Scope: initialize,
 * ping, tools/list, tools/call. That is all an agent needs to use KAI's tools.
 *
 * Exposure rules, checked in this order on every request:
 *   1. Bound to 127.0.0.1 only. Nothing on the LAN can connect.
 *   2. Host must be this loopback port (DNS-rebinding guard, as Core does).
 *   3. Any request carrying an Origin header is refused: browsers send one,
 *      local MCP clients don't. A web page can never drive the bridge.
 *   4. POST /mcp only.
 *   5. Authorization: Bearer <token>, compared in constant time.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
const MAX_CONCURRENT_CALLS = 4;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  if (!m || !token) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * startMcpServer({ port, getToken, info, listTools, callTool, onActivity })
 *   listTools()                    → [{ name, description, inputSchema, annotations }]
 *   callTool(name, args, signal)   → { content, isError? }   (never throws)
 *   onActivity({ client })         ← initialize seen
 * Resolves to { port, close() } once listening.
 */
function startMcpServer({ port, getToken, info, instructions, listTools, callTool, onClient = () => {} }) {
  let active = 0;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, "Internal error"));
      else res.destroy();
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.requestTimeout = 15 * 60 * 1000; // a workflow run or model load can take a while
  server.headersTimeout = 30 * 1000;

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(payload ? { "content-type": "application/json" } : {}),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(payload);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(req, res) {
    const p = server.address()?.port ?? port;
    const hosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) {
      return send(res, 403, { error: "Refused: use the local address and port shown in MCP Bridge." });
    }
    if (req.headers.origin !== undefined) {
      return send(res, 403, { error: "Refused: MCP Bridge does not answer web pages." });
    }
    const path = String(req.url || "").split("?")[0];
    if (path !== "/mcp") return send(res, 404, { error: "Not found" });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" }, { allow: "POST" });
    if (!tokenMatches(req.headers.authorization, getToken())) {
      return send(res, 401, { error: "A valid bearer token is required. Copy it from MCP Bridge in KAI." }, { "www-authenticate": 'Bearer realm="kai-mcp-bridge"' });
    }

    let raw;
    try { raw = await readBody(req); }
    catch (e) { return send(res, e.status || 400, rpcError(null, -32600, e.status === 413 ? "Request too large" : "Unreadable request")); }
    let message;
    try { message = JSON.parse(raw); }
    catch { return send(res, 400, rpcError(null, -32700, "Parse error")); }

    // Cancel tool work if the client goes away before we answer.
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(Error("Client disconnected")); });

    const batch = Array.isArray(message);
    const messages = batch ? message : [message];
    if (!messages.length) return send(res, 400, rpcError(null, -32600, "Empty batch"));
    const replies = [];
    for (const m of messages) {
      const reply = await dispatch(m, controller.signal);
      if (reply) replies.push(reply);
    }
    if (!replies.length) return send(res, 202);
    return send(res, 200, batch ? replies : replies[0]);
  }

  async function dispatch(m, signal) {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return rpcError(m?.id, -32600, "Invalid request");
    }
    const isNotification = m.id === undefined || m.id === null;
    if (isNotification) return null; // notifications/initialized, cancelled, …

    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        const ci = m.params?.clientInfo;
        if (ci && typeof ci.name === "string") onClient({ name: ci.name.slice(0, 80), version: String(ci.version ?? "").slice(0, 40) });
        return rpcResult(m.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
        return rpcResult(m.id, {});
      case "tools/list":
        return rpcResult(m.id, { tools: listTools() });
      case "tools/call": {
        const name = m.params?.name;
        const args = m.params?.arguments ?? {};
        if (typeof name !== "string") return rpcError(m.id, -32602, "tools/call needs a tool name");
        if (typeof args !== "object" || Array.isArray(args)) return rpcError(m.id, -32602, "arguments must be an object");
        if (active >= MAX_CONCURRENT_CALLS) {
          return rpcResult(m.id, { content: [{ type: "text", text: "MCP Bridge is busy with other calls; try again shortly." }], isError: true });
        }
        active++;
        try { return rpcResult(m.id, await callTool(name, args, signal)); }
        finally { active--; }
      }
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startMcpServer, tokenMatches, SUPPORTED_VERSIONS };
