# MCP Bridge for KAI Core

A KAI Core plugin that lets AI agents on the same computer, such as Claude Code, Claude Desktop or Cursor, use KAI through the [Model Context Protocol](https://modelcontextprotocol.io).

- Plugin ID `community.mcp-bridge`, version 0.1.2, native runtime, needs KAI Core 0.7.17 or later.
- No dependencies: Node built-ins only, CommonJS, about 1,500 lines including the window and its five languages.
- Signed packages are in `dist/`, each version signed once (0.1.1 was a source-only step and was never signed). Publisher fingerprint: `0d4883f800992901f1f4941e898031aafd10926cd5d87c0b0cfd166840df416b`.

## Why a plugin

Alpha served tasks, chats, documents, keys, memory, teams and the node over its local HTTP control plane, and the standalone [koinos-ai-mcp](https://github.com/Justyoureverydaynormalguybob/koinos-ai-mcp) server wrapped them. On Core those features belong to plugins and are reachable only through Foundation's plugin API, not over HTTP. That is the right design, and it means an outside agent can reach them only through a plugin that a person has installed and approved.

This plugin is that bridge. It uses only the documented Foundation API v1 and the local service bus, and it leans on each plugin's own approval dialogs instead of adding new ways around them. It's local to the computer; it isn't a remote endpoint like Remote Access.

## How it keeps the user in charge

| Rule | How |
| --- | --- |
| Installing starts nothing | The endpoint runs only after **Turn on** in the bridge window. `startBackground()` resumes only that explicit choice, and a failure there is shown in the window rather than thrown at Core. |
| Local only | It binds to `127.0.0.1`, on a port picked at random for each install. The Host header must match exactly, as a DNS-rebinding guard like Core's own. **Any request with an `Origin` header is refused**, including `Origin: null`, so a web page can never drive it. It accepts one JSON-RPC message per POST to `/mcp` (no batches), at most 32 connections, and closes refused connections. |
| Token | 32 random bytes, checked in constant time, stored encrypted with `api.secrets`. It refuses to turn on without secure storage, including Linux's plain-text `basic_text` fallback. **Make a new token** locks out old clients at once and withdraws any Assistant conversations shared with the bridge. If the port turns out to be taken by another program, the token is replaced automatically, because that program may have collected it from a client. |
| Opt-in per plugin | Documents, Workflows, Brain, Assistant, Code and Tools are each off until ticked. With none ticked, agents see two read-only tools. |
| Changes | Hidden until **Allow changes** is ticked. Even then, a person approves every change in the KAI window, never the agent (see below). Arguments are checked before anything is shown, and agent-supplied text is quoted with control and bidi characters stripped, so an agent can't write its own message into a KAI dialog. One approval at a time, with a pause after a decline. |
| No data kept | Tool arguments and results are never logged or stored. The activity list holds tool name, time, duration and success, in memory only. Results over 4 MB are refused. |

### Who approves each change

| Tool | Approved by | Needs open in KAI |
| --- | --- | --- |
| `model_ensure`, `privacy_set` | Core's own review (`models.ensure`, `network.configure`) | MCP Bridge |
| `document_save`, `workflow_cancel` | The bridge (`api.desktop.confirm`). It shows the document's current title and the start of the new content, or the run's name. | MCP Bridge |
| `workflow_run`, `brain_remember`, `chats_share` | The owning plugin's own dialog | That plugin |
| `chats_revoke` | Nobody needed: it only removes access, so it's available whenever the Assistant source is on, even without **Allow changes**. Turning the Assistant source off also withdraws shared conversations. | none |

Agent requests carry **no initiating window**, on purpose: no person pressed anything in a KAI page. So Core shows a provider's dialog only while that provider's page is open, and the tool descriptions tell the agent to ask the user to open it.

Assistant also asks every time a conversation list or an unshared conversation is read. That's Assistant's own rule, and the bridge doesn't work around it.

### Never wrapped, at any setting

- `kai.tools` `call` / `payment` / `paymentEvents`: generic tool execution and paid runs. Tools can be **listed**, never run.
- Everything in `kai.connections`: email, calendar and third-party account actions.
- Brain `tool`, `context`, `sync` and `source`: tool execution and network fetches.
- Assistant `chats.save` / `chats.grantWrite`.
- Workflows' runtime-wide `status`. It returns every workflow, every run's step inputs and outputs, the connected accounts and Brain's sources. The bridge reads only runs it started itself, reduced to status and final output. `workflow_get` returns steps by id, type and label only, never their settings, which can hold request headers and keys.
- **Destructive deletes** (Documents `remove`, Brain `forget`), until a provider's dialog can say an agent asked. Today it would read like the user's own action.
- Wallet, credits and account requests. The manifest doesn't ask for `wallet.*`, `account.request`, `inference.network`, `network.fetch` or `desktop.external`.

The test suite enforces this. With every source on and changes allowed, it calls every tool and checks each plugin-service method reached against an explicit allowlist. It also greps the tool code and the manifest for the banned families.

### What the bridge cannot protect against

- **Data leaves the computer through the agent.** Anything an agent reads through the bridge goes to that agent's AI provider (with Claude Code, Anthropic's servers). KAI's Local-Only setting doesn't cover this, because the agent runs outside KAI. The bridge window says so above the source list.
- **Reads have no prompt.** Approvals cover changes. Reads of an enabled source don't ask, except Assistant, which asks every time on its own. A prompt-injected agent with Brain or Documents enabled can read them. Enable only what the task needs.
- **Copies of the token outside KAI.** KAI stores it encrypted, but the client's copy isn't. Adding it puts it in the client's config (Claude Code writes it in plain text to `~/.claude.json`), in shell history if typed into a terminal, and in clipboard history if copied. Software running as the user can take it from there, though such software can read KAI's data files directly anyway.
- **Assistant shares belong to the plugin.** Conversations shared with the bridge stay readable by whoever holds a valid token until revoked.
- **Client names are self-reported.** "Last connected" shows what the client says it is.
- **It's native code.** Like every native plugin, it runs with KAI's full rights.

## Security review

Two independent reviews of 0.1.0 found these issues: one on 2026-11-02, and a second on 2026-11-03, published as the source-only 0.1.1. Both sets are merged in 0.1.2, with a regression test for each in `test/review-fixes.test.js`:

| Finding | Fix |
| --- | --- |
| `workflow_status` with no id returned Workflows' whole store, including step outputs, Connections accounts and Brain sources, with only Workflows ticked | Only runs the bridge started, reduced to status and output; graphs reduced to step id, type and label |
| Approval text was agent-controlled (a title claim, injected newlines and fake notices) and shown before validation | Validate first; show facts from the provider; quote and flatten agent text |
| The listener inherited the window's call context, so agent requests looked like the bridge window had asked, and a page reload broke every call | The listener starts outside that context (`AsyncLocalStorage.snapshot()`) |
| An unbounded batch could block KAI's main process (one 1 MiB batch produced a 236 MB reply) | Batches refused; results capped at 4 MB |
| A fixed, well-known port invited squatting and token capture | Random port per install; token replaced if the port is taken |
| No connection cap; a server `error` with no listener could crash the main process | 32-connection cap; a permanent error handler; refused connections closed |
| Approvals could stack and outlive their request | One approval at a time, pause after a decline, the request's signal passed to `confirm` |
| Linux `basic_text` counted as secure storage | Refused |
| `pack.js` key guard was case-sensitive and packed the working tree | Real-path, case-insensitive check; refuses uncommitted `plugin/` files |
| Assistant conversations shared with the bridge outlived a new token, and turning the source off didn't withdraw them | Both now withdraw them |
| `chats_revoke` was hidden behind **Allow changes**, though it only removes access | Always available while the Assistant source is on |
| A document title with line breaks or bidi characters could be saved, and shown cleaned while stored raw | Refused: titles must be one line of plain text |
| The token's other copies (shell history, client settings) weren't mentioned | The bridge window and README say so |

Still open, by design or for Core to decide: IPv6 `::1` isn't bound (the configured URL always uses `127.0.0.1`), and the token doesn't expire until rotated.

## Tools

| Source | Read | Change |
| --- | --- | --- |
| Core (always) | `kai_status`, `models_list` | `model_ensure`, `privacy_set` |
| Documents | `documents_list`, `document_get` | `document_save` |
| Workflows | `workflows_list`, `workflow_get`, `workflow_status` (own runs) | `workflow_run`, `workflow_cancel` (own runs) |
| Brain | `brain_search`, `brain_goals`, `brain_sources` | `brain_remember` |
| Assistant | `chats_list`, `chat_get` | `chats_share`, `chats_revoke` |
| Koinos Code | `code_projects` | none |
| KAI Tools | `tools_list` (names and descriptions only) | none |

Local inference isn't wrapped. KAI's `/v1` API on `127.0.0.1:41100` is already OpenAI-compatible, so agents use it directly.

## Permissions requested

- `native.execute`: the service itself.
- `models.read` / `models.manage`: list models, and load them through Core's review.
- `network.status` / `network.configure`: show privacy, and change it through Core's review.
- `storage.read` / `storage.write`: the bridge's own settings.
- `secrets.use`: encrypting its token.
- `services.call`: the opt-in plugin sources.

It consumes `kai.documents`, `kai.workflows`, `kai.brain`, `kai.assistant`, `kai.code` and `kai.tools`. A missing provider only produces Core's usual "Install and enable a plugin providing …" when that source is used.

## Install and connect

1. In KAI: **Plugins → Install 3rd Party Plugins**, choose the newest `dist/kai-plugin-mcp-<version>.kaiplugin`, check the publisher fingerprint above, and accept the full-access notice for a native plugin.
2. Open **MCP Bridge**, press **Turn on**, and tick what agents may use.
3. Press **Copy** under the Claude Code command and run it once. The visible text shows `<token>` on purpose; only the Copy button carries the real token:
   ```sh
   claude mcp add --transport http kai http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```
   Other clients take the JSON block shown under it. Keep that out of any project config that gets committed.

## Build, test, sign

```sh
npm test                                      # node:test, no dependencies
node scripts/pack.js --core <kai-core checkout> --key <ed25519 key outside this repo>
```

`scripts/pack.js` runs Core's own `scripts/core/pack-plugin.js` and `verifyPackage`, so the package format is never re-implemented here. It refuses a key stored inside the repository, refuses to pack uncommitted plugin files, and never overwrites a published version. The service also loads cleanly through Core's `loadNative`, which enforces the bundled-dependencies rule.

## For KAI maintainers

This is offered for the KAI plugin catalog, and it's entirely your call:

- **List it as is**: `community.mcp-bridge` under its current publisher key, like `community.teleno-node`.
- **Adopt it**: re-sign it under your key with your own ID (for example `kai.mcp-bridge`). Core binds an ID to its first publisher, so adopting means a new ID rather than taking this one over. MIT licensed, so take whatever is useful.
- **Leave it**: it still works as a third-party install.

Things worth knowing, and one request:

1. **Bridge calls carry no initiator.** A native service handling agent requests has no window, so provider approvals appear only while the provider's page is open, and they can't say who asked. This is why Documents `remove` and Brain `forget` are left out. **Request:** when a service call has no initiator, Core could treat the calling plugin as the requester: `confirm` would show "Requested by <caller>" (here, "MCP Bridge, on behalf of an external agent") and use the caller's view. That would make agent-requested changes clear everywhere, help any plugin that calls another from a background task, and let those tools come back. (A plugin *can* step outside an inherited context with `AsyncLocalStorage.snapshot()`, which the bridge does. What it can't do is give itself a requester identity, which is right.)
2. **Core's model and privacy reviews name only the alias or mode.** Including the download size, and a line on what `network` mode sends off the machine, would help every plugin that calls them.
3. `desktop.confirm` returns false while KAI is hidden in the tray, so agent-requested changes need the window open. That's a reasonable rule for an approval, and the bridge tells the agent so.

## Relationship to KAI

Independent and unaffiliated, built from the outside against the shipping KAI Core Beta and its public plugin guide. Nothing here is endorsed by, or the responsibility of, the KAI project.
