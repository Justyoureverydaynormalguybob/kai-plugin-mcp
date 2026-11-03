# Release notes

## 0.1.1 (2026-11-03)

Security fixes from an audit. Not yet signed: build with `scripts/pack.js`.

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
