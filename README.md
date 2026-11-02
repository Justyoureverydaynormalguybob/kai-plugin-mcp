# MCP Bridge for KAI Core

A KAI Core plugin that lets AI agents on the same computer, such as Claude Code, Claude Desktop or Cursor, use KAI through the [Model Context Protocol](https://modelcontextprotocol.io).

- Plugin ID `community.mcp-bridge`, version 0.1.0, native runtime, needs KAI Core 0.7.17 or later.
- No dependencies: Node built-ins only, CommonJS, about 1,400 lines including the window and its five languages.
- The signed package is in `dist/`. Publisher fingerprint: `0d4883f800992901f1f4941e898031aafd10926cd5d87c0b0cfd166840df416b`.

## Why a plugin

Alpha served tasks, chats, documents, keys, memory, teams and the node over its local HTTP control plane, and the standalone [koinos-ai-mcp](https://github.com/Justyoureverydaynormalguybob/koinos-ai-mcp) server wrapped them. On Core those features belong to plugins and are reachable only through Foundation's plugin API, not over HTTP. That is the right design, and it means an outside agent can reach them only through a plugin that a person has installed and approved.

This plugin is that bridge. It uses only the documented Foundation API v1 and the local service bus, and it leans on each plugin's own approval dialogs instead of adding new ways around them.

## How it keeps the user in charge

| Rule | How |
| --- | --- |
| Installing starts nothing | The endpoint runs only after **Turn on** in the bridge window. `startBackground()` resumes only that explicit choice, and a failure there is shown in the window rather than thrown at Core. |
| Local only | It binds to `127.0.0.1`. The Host header must be the loopback port, as a DNS-rebinding guard like Core's own. **Any request with an `Origin` header is refused**, so a web page can never drive it. It accepts POST `/mcp` only. |
| Token | 32 random bytes, stored encrypted with `api.secrets` (it refuses to turn on without secure storage), shown only in the bridge's own window and checked in constant time. **Make a new token** locks out old clients at once. |
| Opt-in per plugin | Documents, Workflows, Brain, Assistant, Code and Tools are each off until ticked. With none ticked, agents see two read-only tools. |
| Changes | Hidden until **Allow changes** is ticked. Even then, a person approves every change in the KAI window, never the agent (see below). If the window is hidden, `desktop.confirm` returns false and the change is refused. |
| No data kept | Tool arguments and results are never logged or stored. The activity list holds tool name, time, duration and success, in memory only. |

### Who approves each change

| Tool | Approved by |
| --- | --- |
| `model_ensure`, `privacy_set` | Core's own review (`models.ensure`, `network.configure`) |
| `workflow_run`, `brain_remember`, `brain_forget`, `document_remove`, `chats_share` | The owning plugin's own dialog |
| `document_save`, `workflow_cancel` | The bridge (`api.desktop.confirm`), because the provider has no dialog for these |
| `chats_revoke` | Nobody needed: it only removes access |

Assistant also asks every time a conversation list or an unshared conversation is read. That is Assistant's own rule, and the bridge doesn't work around it.

### Never wrapped, at any setting

- `kai.tools` `call` / `payment` / `paymentEvents`: generic tool execution and paid runs. Tools can be **listed**, never run.
- Everything in `kai.connections`: email, calendar and third-party account actions.
- Brain `tool`, `context`, `sync` and `source`: tool execution and network fetches.
- Assistant `chats.save` / `chats.grantWrite`.
- Wallet, credits and account requests. The manifest doesn't even ask for `wallet.*`, `account.request`, `inference.network`, `network.fetch` or `desktop.external`.

The test suite enforces this. With every source on and changes allowed, it calls every tool and checks each plugin-service method reached against an explicit allowlist. It also greps the tool code and the manifest for the banned families.

## Tools

| Source | Read | Change |
| --- | --- | --- |
| Core (always) | `kai_status`, `models_list` | `model_ensure`, `privacy_set` |
| Documents | `documents_list`, `document_get` | `document_save`, `document_remove` |
| Workflows | `workflows_list`, `workflow_get`, `workflow_status` | `workflow_run`, `workflow_cancel` |
| Brain | `brain_search`, `brain_goals`, `brain_sources` | `brain_remember`, `brain_forget` |
| Assistant | `chats_list`, `chat_get` | `chats_share`, `chats_revoke` |
| Koinos Code | `code_projects` | none |
| KAI Tools | `tools_list` (names and descriptions only) | none |

Local inference isn't wrapped. KAI's `/v1` API on `127.0.0.1:41100` is already OpenAI-compatible, so agents use it directly.

## Permissions requested

`native.execute` (the service), `models.read` / `models.manage` (list and load models through Core's review), `network.status` / `network.configure` (show privacy and change it through Core's review), `storage.read` / `storage.write` (the bridge's own settings), `secrets.use` (encrypting its token), and `services.call` (the opt-in plugin sources). It consumes `kai.documents`, `kai.workflows`, `kai.brain`, `kai.assistant`, `kai.code` and `kai.tools`. A missing provider only produces Core's usual "Install and enable a plugin providing …" when that source is used.

## Install and connect

1. In KAI: **Plugins → Install 3rd Party Plugins**, choose `dist/kai-plugin-mcp-0.1.0.kaiplugin`, check the publisher fingerprint above, and accept the full-access notice for a native plugin.
2. Open **MCP Bridge**, press **Turn on**, and tick what agents may use.
3. Copy the Claude Code line from the window and run it once:
   ```sh
   claude mcp add --transport http kai http://127.0.0.1:41111/mcp --header "Authorization: Bearer <token>"
   ```
   Other clients take the JSON block shown under it.

## Build, test, sign

```sh
npm test                                      # node:test, no dependencies
node scripts/pack.js --core <kai-core checkout> --key <ed25519 key outside this repo>
```

`scripts/pack.js` runs Core's own `scripts/core/pack-plugin.js` and `verifyPackage`, so the package format is never re-implemented here. It refuses a key stored inside the repository, and it never overwrites a published version. The service also loads cleanly through Core's `loadNative`, which enforces the bundled-dependencies rule.

## For KAI maintainers

This is offered for the KAI plugin catalog, and it's entirely your call:

- **List it as is**: `community.mcp-bridge` under its current publisher key, like `community.teleno-node`.
- **Adopt it**: re-sign it under your key with your own ID (for example `kai.mcp-bridge`). Core binds an ID to its first publisher, so adopting means a new ID rather than taking this one over. MIT licensed, so take whatever is useful.
- **Leave it**: it still works as a third-party install.

Two Foundation behaviours worth knowing about, in case either isn't intended:

1. Service-bus calls made from the bridge's HTTP handler carry no initiating renderer, because a remote agent has no window. Providers that use `api.desktop.confirm` work as expected. A provider that ever requires `initiator` would refuse bridge calls, which is the safe result.
2. `desktop.confirm` returns false while KAI is hidden in the tray, so agent-requested changes need the window open. That's a reasonable rule for an approval, and the bridge tells the agent so.

## Relationship to KAI

Independent and unaffiliated, built from the outside against the shipping KAI Core Beta and its public plugin guide. Nothing here is endorsed by, or the responsibility of, the KAI project.
