# pi-ard: Spec of record (v0.1)

Source: the `pi-ard-spec` document (2026-10). This file is the condensed, testable version. Rule ids are cited in tests.

## Goal
Let a Pi user discover ARD resources across **any** ARD registry the owner configures, and install skills and MCP servers **only with explicit human confirmation**. The surface stays small, and the package is honest about what trust it can and cannot establish today.

## Non-goals (v0.1)
- Signature or attestation verification. ARD v0.91 delegates it to trust frameworks, and none are finalized.
- Running A2A agents. Federated search fan-out (referrals are shown, not followed). Auto-update.
- Reading config from project directories, since a cloned repo must not be able to add registries or trust.

## Rules
| Id | Rule | Test |
| :-- | :-- | :-- |
| R1 | Registries come from user config. `url` gets `/search` appended; `searchUrl` is used verbatim. The default is HF Discover. | config.test, client.test "searchUrl" |
| R2 | Search sends the ARD §5.3.2 body `{query:{text,filter?}, federation:"referrals", pageSize≤100}`; referrals are shown, never followed. An empty query is rejected client-side. | client.test |
| R3 | Every registry error surfaces its HTTP status and ARD code (Appendix B), with Retry-After when sent. There are no retries and no silent fallback to another registry. | client.test "errors" |
| R4 | Catalog: `ard.json` first, then `ai-catalog.json`. The fallback reason is reported. Invalid entries are listed separately. | client.test catalog |
| R5 | `ard_catalog` fetches only from trusted domains. | pi-e2e.test |
| R6 | HTTPS only (loopback http allowed). No URL credentials. Same-host GET redirects only. Timeout and size caps. | client.test http safety |
| R7 | An entry is installable only if structurally valid and, when a trustManifest is present, its identity is bound to the publisher (§4.5.1). | entry.test, install.test |
| R8 | Every write or registration requires `ctx.ui.confirm`. There is no bypass parameter. No UI means refuse. | install.test, pi-e2e.test, rpc-smoke |
| R9 | `ard_install` accepts only identifiers returned this session by search or catalog, so the model cannot supply an entry body. If two sources return one identifier with different locations, it is not installable. | pi-e2e.test |
| R10 | The confirm prompt shows identifier, publisher, fetch URL, destination, trust status (and reason) and signature status. A declared manifest lists its attestation types and is labeled "signature and attestations NOT verified". | install.test |
| R11 | Skills: confirm before fetch. Source resolution never guesses. Frontmatter and a valid name are required. Existing skills are never overwritten. sha256 and URL are recorded in lock.json. | install.test |
| R12 | MCP: an untrusted card host is confirmed before the card is fetched. Remotes must be HTTPS. stdio needs a second confirmation. Registration is session-scoped and the persist command is returned. | install.test |
| R13 | Tool output labels relevance ≠ trust and descriptions as third-party data. | pi-e2e.test |

## Resolved open questions (from spec §9)
1. **Live registry behavior.** HF Discover and GitHub Agent Finder both answer `/search`. Both return `application/ai-skill`, and GitHub returns `application/mcp-server+json` (registry server.json). Neither type is in ARD v0.91, so both are mapped explicitly. `huggingface.co/.well-known/ard.json` returns 401 HTML, and `ai-catalog.json` works, which motivates R4. Recorded in `test/fixtures/live/` on 2026-10-16.
3. **Pi confirm API.** `ctx.ui.confirm(title, message)` works in TUI and RPC modes. `ctx.hasUI` is false in print/json mode.
4. **Paths.** Skills go to `<agentDir>/skills/` (via `getAgentDir()`, which honors `PI_CODING_AGENT_DIR`). MCP uses `pi.registerMcpServer` (session) or `pi mcp add` (persistent).
7. **Existing packages.** There is no ARD package on npm or pi.dev, and no official ARD SDK (see DESIGN.md).
