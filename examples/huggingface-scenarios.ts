/**
 * Real-world Hugging Face scenarios, run live through the same code paths the Pi tools use.
 * Read-only except scenario 3, which installs into a temp agent dir with an auto-"yes" confirm
 * (the confirm text is printed so you can see exactly what a user would be asked).
 *
 * Run: node --experimental-strip-types examples/huggingface-scenarios.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCatalog, search } from "../src/core/client.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { install } from "../src/core/install.ts";
import type { ArdConfig, ArdEntry } from "../src/core/types.ts";

const hf = DEFAULT_CONFIG.registries[0]!;
const config: ArdConfig = { registries: [hf], trustedDomains: ["huggingface.co", "hf.space", "github.com", "raw.githubusercontent.com"] };
const agentDir = mkdtempSync(join(tmpdir(), "pi-ard-hf-"));
const show = (e: ArdEntry) => `  ${e.type}  ${e.identifier}`;
const yes = async (title: string, body: string) => (console.log(`  ┌ confirm: ${title}\n${body.split("\n").map((l) => `  │ ${l}`).join("\n")}\n  └ (answering yes)`), true);
const register = (name: string, cfg: Record<string, unknown>) => console.log(`  registered "${name}" ${JSON.stringify(cfg)}`);

console.log("\n1. What does huggingface.co publish? (ard_catalog)");
const cat = await fetchCatalog("huggingface.co");
console.log(`  via ${cat.path}${cat.fallbackReason ? ` (${cat.fallbackReason})` : ""}`);
cat.entries.forEach((e) => console.log(show(e)));

console.log('\n2. "Find me a skill for training a model" (ard_search, filtered to skills)');
const train = await search(hf, { text: "fine-tune a language model", types: ["application/agent-skills+md"], pageSize: 5 });
train.results.forEach((e) => console.log(show(e)));

console.log("\n3. Install the LLM trainer skill (ard_install)");
const trainer = train.results.find((e) => e.identifier.endsWith(":huggingface-llm-trainer"));
if (trainer) {
	const out = await install(trainer, { config, agentDir, confirm: yes, register });
	console.log(`  → ${out.status}${"missing" in out && out.missing.length ? `; SKILL.md cites ${out.missing.length} bundled files not installed, e.g. ${out.missing.slice(0, 3).join(", ")}` : ""}`);
} else console.log("  (not in today's results)");

console.log('\n4. "I need image generation tools" (MCP servers from HF Spaces)');
const img = await search(hf, { text: "image generation", types: ["application/mcp-server-card+json"], pageSize: 3 });
img.results.forEach((e) => console.log(show(e)));

console.log("\n5. Add the official Hugging Face MCP server for this session");
const hub = cat.entries.find((e) => e.identifier === "urn:air:huggingface.co:mcp:hub");
if (hub) {
	const out = await install(hub, { config, agentDir, confirm: yes, register });
	console.log(`  → ${out.status}${"persistCommand" in out ? `; keep it with: ${out.persistCommand}` : ""}`);
}
