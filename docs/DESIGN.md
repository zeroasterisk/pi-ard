# Design

## Layout
```
src/core/      host-agnostic ARD client (no Pi imports) — exported as pi-ard/core
  http.ts      one guarded request path: https-only, caps, same-host redirects, ARD error codes
  client.ts    search (§5.3), catalog resolution (§5.1)
  entry.ts     structure checks, publisher binding (§4.5.1), media-type → kind, trust matching
  install.ts   skill + MCP install; the only code that writes or registers; takes a Confirm fn
  config.ts    user config + lock file
src/extension.ts  Pi glue: 3 tools + /ard, session cache of seen entries
```

## Decisions (ADR-style)

**D1: Write our own small client instead of using an SDK.** We surveyed this on 2026-10-16. `ards-project` publishes only `ard-spec` and `ard-connectors` (prompt/MCP connectors), with no SDK. `ai-catalog@0.1.2` and `ai-catalog-sdk@0.0.1` on npm target the predecessor AI Catalog document, have no `/search` client, and the second is a 0.0.1 placeholder. ARD's client surface is two endpoints. `src/core` is about 400 lines with no runtime dependencies and sits behind `pi-ard/core`, so an official SDK can replace it without touching the Pi surface.

**D2: Install by identifier from a session cache.** The model gives only an identifier. The entry body must come from a registry response in the same session. This closes the "model fabricates an entry pointing at evil.com" path. The cost is that the user must search or browse first, which they would anyway.

**D3: Confirm is a function, not a flag.** `install()` takes `confirm: (title, body) => Promise<boolean>`. The extension wires it to `ctx.ui.confirm`. There is no `confirmed: true` parameter anywhere, so no tool-call argument can skip it. When there is no UI, the tool refuses.

**D4: Trust is only an owner allowlist, and it's labeled.** Without a finalized trust framework, the honest signal is "the owner trusts this domain". Results and prompts say trusted/untrusted with the reason. Untrusted installs are allowed, but the prompt is explicit about it. `trustManifest` is shown as declared and unverified. The §4.5.1 identity-domain binding is the one check ARD defines that needs no cryptography, so it is enforced.

**D5: Accept real-world media-type aliases explicitly.** We map `application/ai-skill` and `application/mcp-server+json` because the two largest live registries return them. The mapping is a literal table, not a pattern match.

**D6: MCP servers are session-scoped.** `pi.registerMcpServer` puts nothing on disk. Persisting is the user's explicit `pi mcp add`, which pi-ard prints. This avoids pi-ard owning another config file's contents.

**D7: Skill source resolution never guesses.** GitHub `blob/` → `raw.githubusercontent.com` is GitHub's documented raw mapping. A `tree/` directory has no single file, so without `metadata.raw_url` the install is refused, with a message asking for the raw URL.

## Where verification will go
When a trust framework (for example AI Card trust / Sigstore / SPIFFE SVID) is ready, add a verifier in `entry.ts` that returns `signature: "verified" | "failed"`. `assessTrust` can then let verified entries count as trusted without an allowlist entry. Prompts and output already carry the signature label.
