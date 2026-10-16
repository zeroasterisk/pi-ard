/**
 * Use the host-agnostic core (no Pi) to query real public ARD registries.
 * Run: node --experimental-strip-types examples/search-public-registries.ts "pdf"
 */
import { checkEntry, fetchCatalog, search, signatureLabel } from "../src/core/index.ts";

const text = process.argv[2] ?? "pdf";
const registries = [
	{ name: "huggingface", url: "https://huggingface-hf-discover.hf.space" },
	{ name: "github", searchUrl: "https://agentfinder.github.com/api/v1/search" },
];

for (const reg of registries) {
	try {
		const r = await search(reg, { text, pageSize: 5 });
		console.log(`\n${reg.name} (${r.endpoint}) — ${r.results.length} results`);
		for (const e of r.results) {
			const c = checkEntry(e, false);
			console.log(`  ${c.kind.padEnd(11)} ${e.identifier}\n              ${signatureLabel(c)}${c.problems.length ? `  PROBLEMS: ${c.problems.join("; ")}` : ""}`);
		}
	} catch (e) {
		console.log(`\n${reg.name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

const cat = await fetchCatalog("huggingface.co");
console.log(`\nhuggingface.co catalog via ${cat.path}${cat.fallbackReason ? ` (fallback: ${cat.fallbackReason})` : ""}`);
for (const e of cat.entries) console.log(`  ${e.type}  ${e.identifier}  ${e.url ?? ""}`);
