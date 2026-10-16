# Real-world scenarios: Hugging Face

Everything below was produced live on 2026-10-16 by
[`examples/huggingface-scenarios.ts`](../examples/huggingface-scenarios.ts). That script calls the
same functions the Pi tools call, and its confirm callback prints the dialog text instead of asking.
Registry contents change, so your results may differ. Run it yourself:

```sh
node --experimental-strip-types examples/huggingface-scenarios.ts
```

In Pi you just ask in plain language, and the model picks `ard_search`, `ard_catalog` and
`ard_install` itself. The [demo recording](demo/) shows that flow in a real Pi session.

## Config used

```json
{ "trustedDomains": ["huggingface.co", "hf.space", "github.com", "raw.githubusercontent.com"] }
```

Hugging Face Discover returns HF's own skills as `urn:air:github.com:huggingface:skills:…`, with the
file on `raw.githubusercontent.com`. Trusting them needs both of those domains. With only the default
(`huggingface.co`), they show as **untrusted**: still installable, but the dialog says why.

## 1. "What does huggingface.co publish?"

The model calls `ard_catalog { domain: "huggingface.co" }`.

```
via ai-catalog.json (ard.json: HTTP 401 UNAUTHENTICATED Invalid username or password.)
application/ai-registry+json      urn:air:huggingface.co:registry:discover
application/mcp-server-card+json  urn:air:huggingface.co:mcp:hub
```

`/.well-known/ard.json` answers 401 today, so pi-ard falls back to the predecessor
`ai-catalog.json` and reports why, instead of failing.

## 2. "Find me a skill for fine-tuning a language model"

The model calls `ard_search { text: "fine-tune a language model", type: ["application/agent-skills+md"] }`.

```
application/ai-skill  urn:air:github.com:huggingface:skills:train-sentence-transformers
application/ai-skill  urn:air:github.com:huggingface:skills:transformers-js
application/ai-skill  urn:air:github.com:huggingface:skills:trl-training
application/ai-skill  urn:air:github.com:huggingface:skills:huggingface-llm-trainer
application/ai-skill  urn:air:github.com:huggingface:skills:huggingface-vision-trainer
```

The filter uses the spec type, but HF indexes skills as `application/ai-skill`. pi-ard sends both,
because the spec type alone returns zero results from HF.

## 3. "Install the LLM trainer"

The model calls `ard_install { identifier: "urn:air:github.com:huggingface:skills:huggingface-llm-trainer" }`,
and Pi shows the user:

```
Install skill from ARD?
Name: huggingface-llm-trainer
Identifier: urn:air:github.com:huggingface:skills:huggingface-llm-trainer
Publisher: github.com
Fetch: https://raw.githubusercontent.com/huggingface/skills/main/skills/huggingface-llm-trainer/SKILL.md
Into: ~/.pi/agent/skills
Trust: trusted
Signature: unsigned

Skills instruct the model to run commands and code with your permissions. Review the SKILL.md after install.
```

After the user says yes:

```
installed; SKILL.md cites 18 bundled files not installed, e.g. references/training_methods.md,
references/unsloth.md, scripts/unsloth_sft_example.py
```

pi-ard installs `SKILL.md` only. This skill relies on scripts and references in its GitHub
directory, so the result says so rather than implying a complete install. Skills that are a single
file (for example `huggingface-papers`) report nothing missing.

## 4. "I need image generation tools"

The model calls `ard_search { text: "image generation", type: ["application/mcp-server-card+json"] }`.

```
application/mcp-server-card+json  urn:air:huggingface.co:mcp:space:kulkas2pintu:wan777
```

HF Spaces that expose MCP show up as server cards. Each card's remote is the Space's own host
(`https://kulkas2pintu-wan777.hf.space/gradio_api/mcp/`). Trust is judged on that host, because that
is where tool calls go, so it is trusted here only because `hf.space` is listed.

## 5. "Add the Hugging Face MCP server"

The model calls `ard_install { identifier: "urn:air:huggingface.co:mcp:hub" }`.

```
Add MCP server "huggingface-hub" for this session?
Identifier: urn:air:huggingface.co:mcp:hub
Publisher: huggingface.co
Card: https://huggingface.co/mcp/server-card
Server URL: https://huggingface.co/mcp
Trust: trusted
Signature: unsigned

The server's tools become callable by the model in this session.
```

Result: `mcp-ready; keep it with: pi mcp add huggingface-hub --url https://huggingface.co/mcp`

The server is named from the ARD identifier. The card's own name is `huggingface.co/mcp`, which would
have produced tools called `mcp__mcp__*`. Registration lasts for this session only, and the persist
command is returned for the user to run.
