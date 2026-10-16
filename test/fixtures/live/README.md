# Recorded live responses (2026-10-16)

Used by contract tests so that offline CI exercises real registry shapes. To refresh, run the commands below and keep the file names.

```sh
H=https://huggingface-hf-discover.hf.space/search
G=https://agentfinder.github.com/api/v1/search
J='content-type: application/json'
curl -s -X POST $H -H "$J" -d '{"query":{"text":"paper"},"pageSize":3}' > hf-search-skill.json
curl -s -X POST $H -H "$J" -d '{"query":{"text":"video","filter":{"type":["application/mcp-server-card+json"]}},"pageSize":3}' > hf-search-filter-mcp.json
curl -s -X POST $H -H "$J" -d '{"query":{"text":"deploy","filter":{"type":["application/ai-skill"]}},"pageSize":3}' > hf-search-filter-skill.json
curl -s -X POST $G -H "$J" -d '{"query":{"text":"pdf"},"pageSize":3}' > gh-search.json
curl -s -X POST $G -H "$J" -d '{"query":{"text":"github","filter":{"type":["application/mcp-server+json"]}},"pageSize":3}' > gh-search-filter.json
curl -s https://huggingface.co/.well-known/ai-catalog.json > hf-ai-catalog.json
curl -s https://huggingface.co/mcp/server-card > hf-mcp-server-card.json
curl -s "https://api.mcp.github.com/oss/v0.1/servers/microsoft%2Fmarkitdown/versions/latest" > mcp-registry-markitdown.json
curl -s https://raw.githubusercontent.com/huggingface/skills/main/skills/huggingface-paper-publisher/SKILL.md > hf-skill-paper-publisher.md
# error shapes (body + status)
curl -s -w '%{http_code}' -X POST $H -H "$J" -d '{}' > hf-search-400.txt
curl -s -w '%{http_code}' -X POST $G -H "$J" -d '{}' > gh-search-400.txt
curl -s -o /dev/null -w '%{http_code} %{content_type}' https://huggingface.co/.well-known/ard.json > hf-ard-json-status.txt
```

Observations that shaped the code:
- Both registries return `application/ai-skill` (not in ARD v0.91), and GitHub returns `application/mcp-server+json`.
- GitHub sends `mediaType` alongside `type`.
- HF returns FastAPI `422 {detail:[…]}` for validation errors. GitHub returns ARD-style `400 {error:"INVALID_ARGUMENT"}`.
- `huggingface.co/.well-known/ard.json` returns 401 HTML. `ai-catalog.json` (specVersion 1.0) works.
