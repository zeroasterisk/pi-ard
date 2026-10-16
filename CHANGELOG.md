# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- MCP server names come from the ARD identifier, not the card. HF's official card is named `huggingface.co/mcp`, which registered as `mcp` (tools `mcp__mcp__*`); it is now `huggingface-hub`.
- Skill installs report bundled files the SKILL.md cites but that were not installed (e.g. HF `huggingface-paper-publisher` → `scripts/paper_manager.py`). Only SKILL.md is fetched; the result used to read as a complete install.
- Skills without a frontmatter `description` are refused. Pi silently skips them, so they used to install "successfully" and never load. Frontmatter is now parsed with Pi's own `parseFrontmatter` (handles YAML folding) instead of a regex.
- Type filters now include the registry aliases of the same kind. Live HF returned 0 skills for `application/agent-skills+md` (it indexes `application/ai-skill`); GitHub likewise for MCP.

### Removed
- `pi-ard/core` export. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so it never worked for npm consumers. The code still lives in `src/core` with no Pi imports.

## [0.1.0] - 2026-10-16
### Added
- `ard_search`: ARD v0.91 `/search` against any configured registry (`url` or `searchUrl`).
- `ard_catalog`: `/.well-known/ard.json` with `ai-catalog.json` fallback, trusted domains only.
- `ard_install`: skills to `<agent-dir>/skills/`, MCP servers registered for the session. Every install needs Pi UI confirmation; stdio MCP needs two.
- `/ard` command: config, registries, trusted domains, installs.
- Trust labeling: trusted/untrusted by owner allowlist; `trustManifest` shown as declared-but-unverified; §4.5.1 identity binding enforced.
- `pi-ard/core`: host-agnostic ARD client.
- Examples: public-registry search, private registry server, real-CLI RPC smoke test.
