/**
 * Real-CLI smoke test: spawn `pi --mode rpc` with this package installed, script the model with
 * a local OpenAI-compatible stub, and answer Pi's confirm dialog over RPC.
 * Run: node --experimental-strip-types examples/rpc-smoke.ts [--decline]
 * Shows that ard_install's confirmation is a real Pi UI request (extension_ui_request method=confirm).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decline = process.argv.includes("--decline");
const SKILL = "---\nname: hello-ard\ndescription: Demo skill installed by pi-ard rpc smoke test\n---\n# hello\n";

// 1. Local ARD registry + artifact host (loopback http is allowed for owner testing).
const ard = createServer((req, res) => {
	if (req.method === "POST" && req.url === "/search") {
		res.writeHead(200, { "content-type": "application/json" }).end(
			JSON.stringify({
				results: [{ identifier: "urn:air:127.0.0.1:skill:hello-ard", displayName: "Hello ARD", type: "application/agent-skills+md", url: `http://127.0.0.1:${port(ard)}/hello/SKILL.md` }],
			}),
		);
	} else if (req.url === "/hello/SKILL.md") res.writeHead(200, { "content-type": "text/markdown" }).end(SKILL);
	else res.writeHead(404).end();
});

// 2. Scripted model: an OpenAI-compatible chat endpoint that calls ard_search, then ard_install.
let turn = 0;
const llm = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const steps = [
			{ tool: "ard_search", args: { text: "hello" } },
			{ tool: "ard_install", args: { identifier: "urn:air:127.0.0.1:skill:hello-ard" } },
			{ text: "Done." },
		];
		const s = steps[Math.min(turn++, steps.length - 1)]!;
		const delta = s.tool
			? { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] }
			: { role: "assistant", content: s.text };
		const chunk = (d: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk(delta, null));
		res.write(chunk({}, s.tool ? "tool_calls" : "stop"));
		res.end("data: [DONE]\n\n");
	});
});

function port(s: ReturnType<typeof createServer>): number {
	return (s.address() as { port: number }).port;
}

await new Promise<void>((ok) => ard.listen(0, "127.0.0.1", ok));
await new Promise<void>((ok) => llm.listen(0, "127.0.0.1", ok));

const agentDir = mkdtempSync(join(tmpdir(), "pi-ard-rpc-"));
mkdirSync(join(agentDir, "pi-ard"), { recursive: true });
writeFileSync(
	join(agentDir, "pi-ard", "config.json"),
	JSON.stringify({ registries: [{ name: "local", url: `http://127.0.0.1:${port(ard)}` }], trustedDomains: ["127.0.0.1"] }),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: { stub: { baseUrl: `http://127.0.0.1:${port(llm)}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "stub", name: "stub", contextWindow: 32000, maxTokens: 1000 }] } },
	}),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root], defaultProvider: "stub", defaultModel: "stub" }));

const pi = spawn(join(root, "node_modules/.bin/pi"), ["--mode", "rpc", "--no-session", "--provider", "stub", "--model", "stub"], {
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" },
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (o: unknown) => pi.stdin.write(`${JSON.stringify(o)}\n`);
const log: string[] = [];
let confirmSeen = "";

const done = new Promise<void>((ok) => {
	createInterface({ input: pi.stdout }).on("line", (line) => {
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (m.type === "extension_ui_request" && m.method === "confirm") {
			confirmSeen = `${m.title}\n${m.message}`;
			console.log(`\n[pi asked the user]\n${confirmSeen}\n[answer: ${decline ? "no" : "yes"}]\n`);
			send({ type: "extension_ui_response", id: m.id, confirmed: !decline });
		}
		if (m.type === "tool_execution_end") {
			const r = m.result as { content?: Array<{ text?: string }> } | undefined;
			const t = r?.content?.map((c) => c.text).join("\n") ?? "";
			log.push(`${m.toolName}: ${t.split("\n")[0]}`);
			console.log(`[${m.toolName}] ${t.split("\n").slice(0, 3).join("\n  ")}`);
		}
		if (m.type === "agent_end") ok();
	});
	pi.on("exit", (code) => {
		console.error(`pi exited early (code ${code})`);
		process.exit(3);
	});
});

send({ type: "prompt", id: "1", message: "find and install the hello skill" });
const timer = setTimeout(() => {
	console.error("timeout");
	process.exit(2);
}, 60_000);
await done;
clearTimeout(timer);
pi.removeAllListeners("exit");
pi.kill();
ard.close();
llm.close();

const installed = existsSync(join(agentDir, "skills", "hello-ard", "SKILL.md"));
console.log(`\nconfirm dialog sent by pi: ${confirmSeen ? "yes" : "NO"}`);
console.log(`skill on disk: ${installed}`);
const ok = !!confirmSeen && installed === !decline;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
