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
 *                         network.configure).
 *   approval "provider" — the owning plugin shows its own dialog (Workflows
 *                         run, Brain remember/forget, Documents remove,
 *                         Assistant sharing).
 *   approval "bridge"   — the provider has no dialog for this operation, so
 *                         the bridge asks with api.desktop.confirm first.
 *
 * Deliberately NOT wrapped at any setting: kai.tools call/payment (generic
 * tool execution and paid runs), everything in kai.connections (email,
 * calendar and third-party account actions), Brain tool/context/sync/source
 * (tool execution and network fetches), Assistant chat writes, wallet and
 * credit operations, account requests, and the Core settings that move
 * money or re-point the node. A test greps this file to keep it that way.
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
      "plugin sources the user has opened to agents in the bridge. Start here.",
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
    description:
      "CHANGE — ask KAI to download (if needed) and load a local model by alias. KAI shows its own " +
      "review in its window, with the download size, and the user approves or cancels there. " +
      "Downloads can be several GB.",
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
      "'local-first' (network fallback) or 'network'. Any mode other than local-only can send " +
      "prompts to other computers. KAI reviews the change in its window.",
    inputSchema: obj({ mode: str("Privacy mode", { enum: PRIVACY_MODES }) }, ["mode"]),
    handler: async (ctx, args) => {
      if (!PRIVACY_MODES.includes(args.mode)) throw Error(`mode must be one of: ${PRIVACY_MODES.join(", ")}`);
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
      "to document_save or document_remove so a document changed in the meantime is never overwritten.",
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
      "user approves in the KAI window.",
    inputSchema: obj({
      title: str("Title (up to 200 characters)"),
      content: str("Full document text (Markdown is fine)"),
      id: str("Existing document id, to update it"),
      revision: str("Revision from document_get (required with id)"),
    }, ["content"]),
    confirm: (args) => ({
      title: args.id ? "Update a document?" : "Create a document?",
      detail: `${args.id ? `Replace document ${args.id}` : "Create a new document"}: “${args.title || "Untitled"}” (${String(args.content ?? "").length} characters).`,
    }),
    handler: (ctx, args) => {
      const input = { content: text(args.content, "content", 10_000_000), title: typeof args.title === "string" ? args.title : "" };
      if (args.id !== undefined) {
        input.id = id(args.id);
        input.revision = text(args.revision, "revision", 200);
      }
      return ctx.call("kai.documents", "save", input);
    },
  },
  {
    name: "document_remove",
    source: "documents",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE, DESTRUCTIVE — delete a KAI Document. Documents asks the user to confirm in its own " +
      "dialog. The current revision is fetched automatically when not supplied.",
    inputSchema: obj({ id: str("Document id"), revision: str("Revision from document_get (optional)") }, ["id"]),
    handler: async (ctx, args) => {
      const docId = id(args.id);
      const revision = typeof args.revision === "string" ? args.revision : (await ctx.call("kai.documents", "get", { id: docId }))?.revision;
      return ctx.call("kai.documents", "remove", { id: docId, revision });
    },
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
    description: "Read one KAI Workflow's full definition by id (read-only).",
    inputSchema: obj({ id: str("Workflow id from workflows_list") }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.workflows", "get", { id: id(args.id) }),
  },
  {
    name: "workflow_status",
    source: "workflows",
    description:
      "Status of a workflow run by run id, or of the Workflows runtime when no id is given (read-only).",
    inputSchema: obj({ id: str("Run id returned by workflow_run (optional)") }),
    handler: (ctx, args) => ctx.call("kai.workflows", "status", args.id === undefined ? {} : { id: id(args.id) }),
  },
  {
    name: "workflow_run",
    source: "workflows",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE — start a saved KAI Workflow with an optional text input. Workflows shows the user " +
      "the workflow name, input and revision and asks before starting. Returns the run id; follow " +
      "it with workflow_status. A workflow can use the network, connected accounts or credits " +
      "according to how the user built it.",
    inputSchema: obj({
      id: str("Workflow id"),
      input: str("Text input for the run (optional)"),
      revision: { type: "integer", description: "Expected revision from workflows_list (optional; a changed workflow is refused)" },
    }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.workflows", "run", {
      id: id(args.id),
      ...(typeof args.input === "string" ? { input: args.input } : {}),
      ...(Number.isInteger(args.revision) ? { revision: args.revision } : {}),
    }),
  },
  {
    name: "workflow_cancel",
    source: "workflows",
    mutating: true,
    approval: "bridge",
    description: "CHANGE — cancel a running workflow by run id. The user approves in the KAI window.",
    inputSchema: obj({ id: str("Run id returned by workflow_run") }, ["id"]),
    confirm: (args) => ({ title: "Cancel a workflow run?", detail: `Stop workflow run ${args.id}.` }),
    handler: (ctx, args) => ctx.call("kai.workflows", "cancel", { id: id(args.id) }),
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
      ...(typeof args.category === "string" ? { category: args.category } : {}),
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
      "only if they approve; it is marked as agent-written.",
    inputSchema: obj({
      text: str("The memory (up to 12,000 characters)"),
      title: str("Short title (optional)"),
      category: str("Category (optional; Brain falls back to notes)"),
      tags: { type: "array", items: { type: "string" }, description: "Up to 12 tags (optional)" },
    }, ["text"]),
    handler: (ctx, args) => ctx.call("kai.brain", "remember", {
      text: text(args.text, "text", 12000),
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.category === "string" ? { category: args.category } : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags.filter((t) => typeof t === "string").slice(0, 12) } : {}),
    }),
  },
  {
    name: "brain_forget",
    source: "brain",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE, DESTRUCTIVE — remove a personal memory note from KAI Brain by id (from brain_search). " +
      "Brain shows the note and asks the user first. Notes that belong to a connected source cannot be removed this way.",
    inputSchema: obj({ id: str("Memory note id") }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.brain", "forget", { id: id(args.id) }),
  },

  // ----- assistant -----
  {
    name: "chats_list",
    source: "assistant",
    description:
      "List the user's KAI Assistant conversations (titles and metadata). Assistant asks the user " +
      "in its own dialog every time a plugin lists them.",
    inputSchema: obj(),
    handler: via("assistant", "chats.list"),
  },
  {
    name: "chat_get",
    source: "assistant",
    description:
      "Read one KAI Assistant conversation by id. Assistant asks the user first, unless they " +
      "already shared that conversation with the bridge (see chats_share).",
    inputSchema: obj({ id: str("Conversation id from chats_list") }, ["id"]),
    handler: (ctx, args) => ctx.call("kai.assistant", "chats.get", { id: id(args.id) }),
  },
  {
    name: "chats_share",
    source: "assistant",
    mutating: true,
    approval: "provider",
    description:
      "CHANGE — ask the user to share up to 100 Assistant conversations with the bridge so chat_get " +
      "can read them without a dialog each time. Assistant lists them and asks; access lasts until " +
      "revoked (chats_revoke, or Assistant Settings).",
    inputSchema: obj({ ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "Conversation ids" } }, ["ids"]),
    handler: (ctx, args) => {
      if (!Array.isArray(args.ids) || !args.ids.length) throw Error("Missing required argument: ids (non-empty array)");
      return ctx.call("kai.assistant", "chats.grant", { ids: args.ids.map((v) => id(v)).slice(0, 100) });
    },
  },
  {
    name: "chats_revoke",
    source: "assistant",
    mutating: true,
    approval: "none",
    description: "CHANGE — withdraw every Assistant conversation previously shared with the bridge. Only ever reduces access.",
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
        tools: list.map((t) => ({
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
    openWorldHint: false,
  };
}

/** The tools visible under the user's current bridge settings. */
function visibleTools({ sources = {}, allowChanges = false } = {}) {
  return tools.filter((t) => (t.source === "core" || sources[t.source] === true) && (!t.mutating || allowChanges));
}

module.exports = { tools, visibleTools, annotations, SOURCES, PRIVACY_MODES };
