"use strict";
/*
 * The tools an external AI agent sees. Every tool belongs to a source:
 *
 *   core       — Foundation itself (models, runtime, privacy). On whenever
 *                the bridge is on.
 *   documents / workflows / brain / assistant / code / tools
 *              — another installed plugin, reached over Core's local service
 *                bus. Each source is OFF until the user ticks it in the
 *                bridge's own window.
 *
 * Mutating tools are hidden unless the user ticks "Allow changes", and every
 * one is approved by a person in the KAI window — never by the agent:
 *
 *   approval "core"     — Foundation shows its own review (models.ensure,
 *                         network.configure). Needs the MCP Bridge page open.
 *   approval "provider" — the owning plugin shows its own dialog. Bridge
 *                         calls carry no initiating window (they come from an
 *                         agent, not a person at a page), so Core shows that
 *                         dialog only while the OWNING plugin's page is open.
 *   approval "bridge"   — the provider has no dialog for this operation, so
 *                         the bridge asks first. Needs the MCP Bridge page open.
 *
 * Arguments are validated BEFORE any approval is shown, and anything the
 * agent supplies is shown quoted and stripped of control/bidi characters, so
 * an agent cannot write its own text into a KAI dialog.
 *
 * Deliberately NOT wrapped at any setting: kai.tools call/payment (generic
 * tool execution and paid runs), everything in kai.connections (email,
 * calendar and third-party account actions), Brain tool/context/sync/source
 * (tool execution and network fetches), Assistant chat writes, the Workflows
 * runtime-wide status (it returns every run's step data, connected accounts
 * and Brain sources), wallet and credit operations, account requests, and the
 * Core settings that move money or re-point the node. Destructive deletes
 * (Documents remove, Brain forget) are left out until a provider dialog can
 * name the agent as the requester. A test greps this file to keep it that way.
 */

const SOURCES = {
  core: { service: null, label: "KAI Core" },
  documents: { service: "kai.documents", label: "Documents" },
  workflows: { service: "kai.workflows", label: "Workflows" },
  brain: { service: "kai.brain", label: "Brain" },
  assistant: { service: "kai.assistant", label: "Assistant conversations" },
  code: { service: "kai.code", label: "Koinos Code projects" },
  tools: { service: "kai.tools", label: "KAI Tools (list only)" },
};

const PRIVACY_MODES = ["local-only", "local-first", "network"];
const RESULT_TEXT_MAX = 8000;

const obj = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const str = (description, extra = {}) => ({ type: "string", description, ...extra });

function text(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw Error(`Missing required argument: ${name} (non-empty string)`);
  if (value.length > max) throw Error(`${name} is ${value.length} characters; the limit is ${max}`);
  return value;
}
function id(value, name = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw Error(`Missing or invalid argument: ${name}`);
  return value;
}
// Control, bidi-override and zero-width characters: an agent could use them to
// disguise text inside a KAI approval dialog. Built from code points so the
// source holds no invisible characters itself.
const INVISIBLE = new RegExp("[" + [[0x00, 0x1f], [0x7f, 0x9f], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
  .map((range) => range.map((c) => String.fromCharCode(92) + "u" + c.toString(16).padStart(4, "0")).join("-")).join("") + "]", "g");
/** Agent- or user-supplied text, made safe to show inside a KAI dialog. */
function shown(value, max = 200) {
  const clean = String(value ?? "")
    .replace(INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return JSON.stringify(clean.length > max ? clean.slice(0, max) + "…" : clean);
}
const clip = (s, max = RESULT_TEXT_MAX) => (typeof s === "string" && s.length > max ? s.slice(0, max) + `… [${s.length - max} more characters]` : s);

const NEEDS_PAGE = (plugin) =>
  ` ${plugin} shows its own approval, and KAI only shows it while the ${plugin} page is open in KAI. ` +
  `If the result says it was declined or not started, ask the user to open ${plugin} in KAI and try once more; never retry unasked.`;
const NEEDS_BRIDGE_PAGE =
  " The user approves in KAI, which needs the MCP Bridge page open. If it comes back not approved, tell the user; never retry unasked.";

// Through the service bus: Core resolves the provider, starts it if needed,
// and refuses with "Install and enable a plugin providing …" when absent.
const via = (source, method, input = {}) => (ctx) => ctx.call(SOURCES[source].service, method, input);

const tools = [
  // ----- core -----
  {
    name: "kai_status",
    source: "core",
    description:
      "KAI Core status as seen by the MCP Bridge plugin (read-only): AI privacy mode, the local " +
      "runtime (active model, loading stage, inference queue), the interface language, and which " +
      "plugin sources the user has opened to agents in the bridge. Start here. Note: KAI's privacy " +
      "mode governs KAI itself; whatever you read here still goes to your own AI provider.",
    inputSchema: obj(),
    handler: (ctx) => ({
      bridge: { id: ctx.api.plugin.id, version: ctx.api.plugin.version, allowChanges: ctx.allowChanges, sources: ctx.sources },
      privacy: ctx.api.network.status(),
      runtime: ctx.api.runtime.status(),
      language: ctx.api.locale?.get?.().language ?? null,
    }),
  },
  {
    name: "models_list",
    source: "core",
    description:
      "List KAI's local models (read-only): alias, label, status (ready / partial / absent), " +
      "expected weights size, full download size and bytes on disk. Use an alias that is ready " +
      "with KAI's OpenAI-compatible /v1/chat/completions API on 127.0.0.1:41100 for inference.",
    inputSchema: obj(),
    handler: (ctx) => ({ models: ctx.api.models.list() }),
  },
  {
    name: "model_ensure",
    source: "core",
    mutating: true,
    approval: "core",
    openWorld: true,
    description:
      "CHANGE — ask KAI to download (if needed) and load a local model by alias. Downloads can be " +
      "several GB: tell the user the downloadSizeBytes from models_list first, because KAI's review " +
      "names only the model." + NEEDS_BRIDGE_PAGE,
    inputSchema: obj({ alias: str("Model alias from models_list, e.g. koinos-balanced") }, ["alias"]),
    handler: async (ctx, args) => {
      const alias = id(args.alias, "alias");
      const known = ctx.api.models.list().map((m) => m.alias);
      if (!known.includes(alias)) throw Error(`Unknown alias "${alias}". Known aliases: ${known.join(", ")}`);
      return { requested: alias, result: await ctx.api.models.ensure({ alias }, ctx.signal) };
    },
  },
  {
    name: "privacy_set",
    source: "core",
    mutating: true,
    approval: "core",
    description:
      "CHANGE — ask KAI to change its AI privacy mode: 'local-only' (nothing leaves this computer), " +
      "'local-first' (network fallback) or 'network'. Any mode other than local-only lets KAI send " +
      "prompts to other computers: explain that to the user first, because KAI's review names only " +
      "the mode." + NEEDS_BRIDGE_PAGE,
    inputSchema: obj({ mode: str("Privacy mode", { enum: PRIVACY_MODES }) }, ["mode"]),
    handler: async (ctx, args) => {
      if (!PRIVACY_MODES.includes(args.mode)) throw Error(`mode must be one of: ${PRIVACY_MODES.join(", ")}`);
      ctx.alive(); // never apply a change for a bridge that was turned off meanwhile
      return ctx.api.network.configure({ privacyMode: args.mode });
    },
  },

  // ----- documents -----
  {
    name: "documents_list",
    source: "documents",
    description:
      "List the user's saved KAI Documents (read-only): id, title, last update, word count and a " +
      "160-character preview, newest first.",
    inputSchema: obj(),
    handler: via("documents", "list"),
  },
  {
    name: "document_get",
    source: "documents",
    description:
      "Read one KAI Document in full by id (read-only). The result carries a revision; pass it back " +
      "to document_save so a document changed in the meantime is never overwritten.",
    inputSchema: obj({ id: str("Document id from documents_list") }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.documents", "get", { id: id(args.id) }),
  },
  {
    name: "document_save",
    source: "documents",
    mutating: true,
    approval: "bridge",
    description:
      "CHANGE — create a new KAI Document, or replace an existing one's title and content. To " +
      "update, pass the id and the revision from document_get; a stale revision is refused. The " +
      "review shows the document's current title and the start of the new content." + NEEDS_BRIDGE_PAGE,
    inputSchema: obj({
      title: str("Title (up to 200 characters)"),
      content: str("Full document text (Markdown is fine)"),
      id: str("Existing document id, to update it"),
      revision: str("Revision from document_get (required with id)"),
    }, ["content"]),
    // Validate and look up BEFORE asking, so the review shows facts, not claims.
    prepare: async (ctx, args) => {
      const content = text(args.content, "content", 10_000_000);
      let title = "";
      if (args.title !== undefined) {
        if (typeof args.title !== "string") throw Error("title must be a string");
        if (args.title.length > 200) throw Error(`title is ${args.title.length} characters; the limit is 200`);
        // Refused rather than cleaned: a title is stored, so it must be what the user saw.
        if (new RegExp(INVISIBLE.source).test(args.title)) throw Error("title must be one line of plain text");
        title = args.title;
      }
      const input = { content, title };
      let detail;
      if (args.id !== undefined) {
        input.id = id(args.id);
        input.revision = text(args.revision, "revision", 200);
        const current = await ctx.call("kai.documents", "get", { id: input.id });
        if (current?.revision !== input.revision) throw Error("Document changed since it was read. Read it again with document_get.");
        detail = `Replace ALL of the document currently titled ${shown(current?.title)} ` +
          `(${String(current?.content ?? "").length.toLocaleString("en")} characters now). The old text is not kept.\n\n` +
          `New title: ${shown(title || "(taken from the first line)")}\n` +
          `New content (${content.length.toLocaleString("en")} characters) starts:\n${shown(content, 400)}`;
      } else {
        detail = `Create a new document titled ${shown(title || "(taken from the first line)")}.\n\n` +
          `Content (${content.length.toLocaleString("en")} characters) starts:\n${shown(content, 400)}`;
      }
      return { input, title: input.id ? "Replace a document?" : "Create a document?", detail };
    },
    run: (ctx, input) => ctx.call("kai.documents", "save", input),
  },

  // ----- workflows -----
  {
    name: "workflows_list",
    source: "workflows",
    description:
      "List the user's KAI Workflows (read-only): id, name, whether it is still a draft, and its " +
      "revision. Only saved (non-draft) workflows can be run.",
    inputSchema: obj(),
    handler: via("workflows", "listServices"),
  },
  {
    name: "workflow_get",
    source: "workflows",
    description:
      "Describe one KAI Workflow by id (read-only): name, revision, schedule, and its steps by id, " +
      "type and label. Step settings are left out (they can hold request headers and keys).",
    inputSchema: obj({ id: str("Workflow id from workflows_list") }, ["id"]),
    handler: async (ctx, args) => {
      const w = await ctx.call("kai.workflows", "get", { id: id(args.id) });
      const nodes = Array.isArray(w?.graph?.nodes) ? w.graph.nodes : Array.isArray(w?.steps) ? w.steps : [];
      return {
        id: w?.id ?? null,
        name: w?.name ?? null,
        ...(typeof w?.description === "string" ? { description: clip(w.description, 2000) } : {}),
        revision: w?.revision ?? null,
        draft: w?.draft ?? null,
        enabled: w?.enabled ?? null,
        schedule: w?.schedule?.kind ? { kind: w.schedule.kind } : null,
        steps: nodes.map((n) => ({ id: n?.id ?? null, type: n?.type ?? null, ...(typeof n?.label === "string" ? { label: n.label.slice(0, 200) } : {}) })),
      };
    },
  },
  {
    name: "workflow_status",
    source: "workflows",
    description:
      "Status of a workflow run that THIS bridge started with workflow_run (read-only): status, " +
      "times, any error, and the run's latest output. Runs started elsewhere are not readable here.",
    inputSchema: obj({ id: str("Run id returned by workflow_run") }, ["id"]),
    handler: async (ctx, args) => {
      const runId = id(args.id);
      if (!ctx.runs.has(runId)) throw Error("Only runs started through MCP Bridge (with workflow_run) can be read here.");
      const r = await ctx.call("kai.workflows", "status", { id: runId });
      if (!r) return { id: runId, status: "gone" };
      return {
        id: r.id ?? runId,
        workflowId: r.workflowId ?? null,
        name: r.name ?? null,
        status: r.status ?? null,
        startedAt: r.startedAt ?? null,
        finishedAt: r.finishedAt ?? null,
        ...(r.error ? { error: clip(String(r.error), 1000) } : {}),
        output: clip(typeof r.previous === "string" ? r.previous : null),
      };
    },
  },
  {
    name: "workflow_run",
    source: "workflows",
    mutating: true,
    approval: "provider",
    openWorld: true,
    description:
      "CHANGE — start a saved KAI Workflow with an optional text input. Workflows shows the user the " +
      "workflow name, input and revision before it starts. Returns the run id; follow it with " +
      "workflow_status. A workflow can use the network, connected accounts or credits according " +
      "to how the user built it." + NEEDS_PAGE("Workflows"),
    inputSchema: obj({
      id: str("Workflow id"),
      input: str("Text input for the run (optional, up to 8000 characters)"),
      revision: { type: "integer", description: "Expected revision from workflows_list (optional; a changed workflow is refused)" },
    }, ["id"]),
    handler: async (ctx, args) => {
      const out = await ctx.call("kai.workflows", "run", {
        id: id(args.id),
        ...(args.input !== undefined ? { input: text(args.input, "input", 8000) } : {}),
        ...(Number.isInteger(args.revision) ? { revision: args.revision } : {}),
      });
      if (typeof out?.id === "string") ctx.runs.add(out.id);
      return out;
    },
  },
  {
    name: "workflow_cancel",
    source: "workflows",
    mutating: true,
    approval: "bridge",
    description: "CHANGE — cancel a run that this bridge started (run id from workflow_run)." + NEEDS_BRIDGE_PAGE,
    inputSchema: obj({ id: str("Run id returned by workflow_run") }, ["id"]),
    prepare: async (ctx, args) => {
      const runId = id(args.id);
      if (!ctx.runs.has(runId)) throw Error("Only runs started through MCP Bridge (with workflow_run) can be cancelled here.");
      const r = await ctx.call("kai.workflows", "status", { id: runId });
      return { input: { id: runId }, title: "Cancel a workflow run?", detail: `Stop the running workflow ${shown(r?.name ?? "(unknown)")} (run ${runId}).` };
    },
    run: (ctx, input) => ctx.call("kai.workflows", "cancel", input),
  },

  // ----- brain -----
  {
    name: "brain_search",
    source: "brain",
    description:
      "Search the user's KAI Brain memories (read-only): notes and source excerpts ranked for the " +
      "query. Optional category narrows the search.",
    inputSchema: obj({
      query: str("What to look for"),
      count: { type: "integer", minimum: 1, maximum: 25, description: "Maximum results (default 8)" },
      category: str("Only this category (optional)"),
    }, ["query"]),
    handler: (ctx, args) => ctx.call("kai.brain", "search", {
      query: text(args.query, "query", 2000),
      count: Number.isInteger(args.count) ? Math.min(Math.max(args.count, 1), 25) : 8,
      ...(typeof args.category === "string" ? { category: args.category.slice(0, 60) } : {}),
    }),
  },
  {
    name: "brain_goals",
    source: "brain",
    description: "List the goals the user keeps in KAI Brain (read-only).",
    inputSchema: obj(),
    handler: via("brain", "goals"),
  },
  {
    name: "brain_sources",
    source: "brain",
    description: "List the sources (files, folders, sites) the user has connected to KAI Brain (read-only).",
    inputSchema: obj(),
    handler: via("brain", "sourceList"),
  },
  {
    name: "brain_remember",
    source: "brain",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE — save a new memory note to KAI Brain. Brain shows the note to the user and saves it " +
      "only if they approve; it is marked as agent-written." + NEEDS_PAGE("Brain"),
    inputSchema: obj({
      text: str("The memory (up to 12,000 characters)"),
      title: str("Short title (optional, up to 120 characters)"),
      category: str("Category (optional; Brain falls back to notes)"),
      tags: { type: "array", items: { type: "string" }, description: "Up to 12 tags (optional)" },
    }, ["text"]),
    handler: (ctx, args) => ctx.call("kai.brain", "remember", {
      text: text(args.text, "text", 12000),
      ...(typeof args.title === "string" ? { title: args.title.slice(0, 120) } : {}),
      ...(typeof args.category === "string" ? { category: args.category.slice(0, 60) } : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags.filter((t) => typeof t === "string").slice(0, 12) } : {}),
    }),
  },

  // ----- assistant -----
  {
    name: "chats_list",
    source: "assistant",
    description:
      "List the user's KAI Assistant conversations (titles and metadata). Assistant asks the user " +
      "every time a plugin lists them." + NEEDS_PAGE("Assistant"),
    inputSchema: obj(),
    handler: via("assistant", "chats.list"),
  },
  {
    name: "chat_get",
    source: "assistant",
    description:
      "Read one KAI Assistant conversation by id. Assistant asks the user first, unless they " +
      "already shared that conversation with the bridge (see chats_share)." + NEEDS_PAGE("Assistant"),
    inputSchema: obj({ id: str("Conversation id from chats_list") }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.assistant", "chats.get", { id: id(args.id) }),
  },
  {
    name: "chats_share",
    source: "assistant",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE — ask the user to share up to 100 Assistant conversations with MCP Bridge so chat_get " +
      "can read them without a dialog each time. Assistant lists them and asks. Access belongs to " +
      "the bridge plugin, not to one agent, and lasts until revoked (chats_revoke, or Assistant " +
      "Settings); making a new bridge token or turning the Assistant source off also withdraws it." + NEEDS_PAGE("Assistant"),
    inputSchema: obj({ ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "Conversation ids" } }, ["ids"]),
    handler: (ctx, args) => {
      if (!Array.isArray(args.ids) || !args.ids.length) throw Error("Missing required argument: ids (non-empty array)");
      if (args.ids.length > 100) throw Error("Share at most 100 conversations at a time");
      return ctx.call("kai.assistant", "chats.grant", { ids: args.ids.map((v) => id(v)) });
    },
  },
  {
    name: "chats_revoke",
    source: "assistant",
    mutating: true,
    approval: "none",
    description:
      "Withdraw every Assistant conversation previously shared with the bridge. Only ever reduces " +
      "access, so it is available whenever the Assistant source is on, even without Allow changes.",
    inputSchema: obj(),
    handler: via("assistant", "chats.revoke"),
  },

  // ----- code / tools -----
  {
    name: "code_projects",
    source: "code",
    description: "List the user's Koinos Code projects (read-only): id, name, and whether the folder is missing.",
    inputSchema: obj(),
    handler: via("code", "projects"),
  },
  {
    name: "tools_list",
    source: "tools",
    description:
      "List the tools registered in KAI Tools — built-in tools and the MCP servers the user added to " +
      "KAI (read-only; names and descriptions only). The bridge cannot run them.",
    inputSchema: obj(),
    handler: async (ctx) => {
      const out = await ctx.call("kai.tools", "list", {});
      const list = Array.isArray(out?.tools) ? out.tools : [];
      return {
        tools: list.slice(0, 500).map((t) => ({
          name: t?.name ?? null,
          description: typeof t?.description === "string" ? t.description.slice(0, 300) : null,
          ...(t?.server ? { server: t.server } : {}),
          ...(t?.source ? { source: t.source } : {}),
          ...(typeof t?.egress === "boolean" ? { egress: t.egress } : {}),
        })),
      };
    },
  },
];

function annotations(tool) {
  return {
    readOnlyHint: !tool.mutating,
    ...(tool.mutating ? { destructiveHint: /DESTRUCTIVE/.test(tool.description) } : {}),
    openWorldHint: tool.openWorld === true,
  };
}

/**
 * The tools visible under the user's current bridge settings. A change that
 * only ever removes access (approval "none") is never hidden behind Allow
 * changes: taking access away should not need more permission than having it.
 */
function visibleTools({ sources = {}, allowChanges = false } = {}) {
  return tools.filter((t) =>
    (t.source === "core" || sources[t.source] === true) && (!t.mutating || allowChanges || t.approval === "none"));
}

module.exports = { tools, visibleTools, annotations, shown, SOURCES, PRIVACY_MODES };
