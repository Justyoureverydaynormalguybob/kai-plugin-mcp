# Release notes

## 0.1.2 (2026-11-03)

Merges two independent security reviews of 0.1.0. 0.1.1 below is the second review's fixes, published as source only. This release adds the first review's fixes on top. Signed.

- **Workflows (High):** the runtime-wide status, which returns every run's step data, connected accounts and Brain sources, is no longer reachable. `workflow_status` and `workflow_cancel` only cover runs the bridge started, reduced to status and output; `workflow_get` returns steps without their settings.
- **Approvals:** one at a time, with a pause after a decline, and the request's signal passed to Core. Agent text in dialogs is quoted and flattened. Updates say plainly that all of the old text is replaced.
- **Provenance:** agent requests no longer inherit the bridge window's call context (`AsyncLocalStorage.snapshot()`), so they never appear to come from a person at a KAI page, and reloading the page no longer breaks them.
- **Endpoint:** batches refused, results capped at 4 MB, 32 connections, a permanent server error handler, refused connections closed. A random port for each install; if the port is taken, the token is replaced and shared conversations withdrawn.
- **Storage:** Linux `basic_text` refused as insecure.
- **Removed `document_remove` and `brain_forget`** until a provider dialog can name the agent as the requester (0.1.1's handling of a declined delete is therefore no longer needed).
- **Window:** warns that anything an agent reads goes to that agent's AI provider, even with KAI on Local-Only (all five languages).
- `pack.js`: case-insensitive real-path key check; refuses uncommitted plugin files.

## 0.1.1 (2026-11-03)

Security fixes from an audit. Source only; never signed. Superseded by 0.1.2.

- Approval dialogs can no longer be dressed up by the agent. Arguments are validated before the dialog; titles must be one line of plain text, at most 200 characters; dialog text has line breaks and bidi overrides flattened. `document_save` now shows the start of the new content and, for an update, the title Documents really holds for that id.
- A delete declined in Documents (which answers `{ cancelled: true }`) is reported as not approved instead of success.
- Shared Assistant conversations are withdrawn on **Make a new token** and when the Assistant source is turned off. `chats_revoke` is available whenever the Assistant source is on, without **Allow changes**.
- The window warns that the Claude Code command keeps the token in shell history and Claude's settings.
- Docs: Core's model dialog names the model, not the size; how provider dialogs are attributed is described as it is, with a proposed Core fix.

## 0.1.0 (2026-11-02)

First release, for KAI Core 0.7.17 or later.

- Local MCP endpoint (Streamable HTTP, JSON responses) on `127.0.0.1:41111`, off until turned on in the bridge window. Bearer token stored encrypted. Requests with an `Origin` header, a foreign `Host`, or no token are refused.
- Core tools: `kai_status`, `models_list`, `model_ensure`, `privacy_set` (the last two through Core's own reviews).
- Opt-in sources over the local service bus: Documents, Workflows, Brain, Assistant conversations, Koinos Code projects, KAI Tools (listing only).
- Changes are hidden until "Allow changes" is ticked, and each one is approved in the KAI window by Core, the owning plugin, or the bridge.
- Window in English, Español, Português (Brasil), Français and Deutsch, following Core's language setting.
- Signed with publisher `0d4883f800992901f1f4941e898031aafd10926cd5d87c0b0cfd166840df416b`.
