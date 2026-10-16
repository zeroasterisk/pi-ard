import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createPiArd, type PiArdOptions } from "../src/extension.ts";

export interface PiHarness {
	session: AgentSession;
	agentDir: string;
	confirms: Array<{ title: string; body: string }>;
	notifications: string[];
	setResponses(r: FauxResponseStep[]): void;
	toolResults(name: string): string[];
	dispose(): void;
}

/**
 * A real Pi AgentSession with the pi-ard extension loaded through Pi's own extension loader,
 * a scripted (faux) model, and a UI whose confirm() answers come from `answers` in order.
 */
export async function piHarness(opts: { answers?: boolean[]; hasUI?: boolean; ard?: Omit<PiArdOptions, "agentDir">; agentDir?: string } = {}): Promise<PiHarness> {
	const agentDir = opts.agentDir ?? mkdtempSync(join(tmpdir(), "pi-ard-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-ard-cwd-"));
	const answers = [...(opts.answers ?? [])];
	const confirms: PiHarness["confirms"] = [];
	const notifications: string[] = [];

	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 4096, input: ["text"] }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const model = modelRuntime.getModel(faux.provider.id ?? "faux", "faux-1") ?? faux.getModel();

	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		extensionFactories: [createPiArd({ ...opts.ard, agentDir })],
	} as never);
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const hasUI = opts.hasUI ?? true;
	await session.bindExtensions({
		mode: hasUI ? "rpc" : "print",
		uiContext: hasUI
			? ({
					select: async () => undefined,
					confirm: async (title: string, body: string) => {
						confirms.push({ title, body });
						const a = answers.shift();
						if (a === undefined) throw new Error(`Unexpected confirm: ${title}`);
						return a;
					},
					input: async () => undefined,
					notify: (m: string) => notifications.push(m),
					onTerminalInput: () => () => {},
					setStatus: () => {},
					setWorkingMessage: () => {},
					setWorkingVisible: () => {},
					setWorkingIndicator: () => {},
					setHiddenThinkingLabel: () => {},
					setWidget: () => {},
					setFooter: () => {},
					setHeader: () => {},
					setTitle: () => {},
					custom: async () => undefined,
					pasteToEditor: () => {},
					setEditorText: () => {},
					getEditorText: () => "",
					editor: async () => undefined,
					setEditorComponent: () => {},
					getAllThemes: () => [],
					getTheme: () => undefined,
					setTheme: () => ({ success: false }),
					getToolsExpanded: () => false,
					setToolsExpanded: () => {},
				} as never)
			: undefined,
	});

	return {
		session,
		agentDir,
		confirms,
		notifications,
		setResponses: (r) => faux.setResponses(r),
		toolResults: (name) =>
			session.messages
				.filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === name)
				.map((m) => ((m as { content: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n")),
		dispose: () => session.dispose(),
	};
}
