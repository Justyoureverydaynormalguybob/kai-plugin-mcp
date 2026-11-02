# Release notes

## 0.1.0 (2026-11-02)

First release, for KAI Core 0.7.17 or later.

- Local MCP endpoint (Streamable HTTP, JSON responses) on `127.0.0.1:41111`, off until turned on in the bridge window. Bearer token stored encrypted. Requests with an `Origin` header, a foreign `Host`, or no token are refused.
- Core tools: `kai_status`, `models_list`, `model_ensure`, `privacy_set` (the last two through Core's own reviews).
- Opt-in sources over the local service bus: Documents, Workflows, Brain, Assistant conversations, Koinos Code projects, KAI Tools (listing only).
- Changes are hidden until "Allow changes" is ticked, and each one is approved in the KAI window by Core, the owning plugin, or the bridge.
- Window in English, Español, Português (Brasil), Français and Deutsch, following Core's language setting.
- Signed with publisher `0d4883f800992901f1f4941e898031aafd10926cd5d87c0b0cfd166840df416b`.
