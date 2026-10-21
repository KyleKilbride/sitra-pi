import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readConfig } from "../cli/config.ts";
import { type Env, type ExecResult, type InitDeps, PACKAGES, PI_MIN, PI_PACKAGE, runInit } from "../cli/init.ts";

interface Call {
	command: string;
	args: string[];
	env?: Env;
}

/** A machine with the given tools installed (name -> --version output); everything else is "not installed". */
function machine(options: {
	tools?: Record<string, string>;
	answers?: Record<string, string>;
	confirms?: boolean;
	onInstall?: (tools: Record<string, string>) => void;
}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "sitra-init-")));
	const repoRoot = join(home, "sitra-pi");
	mkdirSync(join(repoRoot, "templates", "profile", "agents"), { recursive: true });
	writeFileSync(join(repoRoot, "templates", "profile", "AGENTS.md"), "# Working with {{name}}\n");
	writeFileSync(join(repoRoot, "templates", "profile", "agents", "builder.md"), "{{name}} merges.\n");
	writeFileSync(
		join(repoRoot, "templates", "rpiv-ask-user-question.json"),
		'{"guidance":{"promptSnippet":"Ask {{name}}"}}\n',
	);
	const tools = { pi: "1.0.0", herdr: "herdr 0.9.1", pnpm: "11.5.2", ...options.tools };
	for (const [k, v] of Object.entries(options.tools ?? {})) if (v === "") delete tools[k as keyof typeof tools];
	const calls: Call[] = [];
	const asked: string[] = [];
	const lines: string[] = [];
	const deps: InitDeps = {
		home,
		env: { PATH: `/usr/bin:${join(home, ".local", "bin")}` },
		repoRoot,
		nodeVersion: "24.12.0",
		exec(command, args, opts): ExecResult {
			calls.push({ command, args, env: opts?.env });
			if (!(command in tools)) return { code: 127, stdout: "" };
			if (args[0] === "--version") return { code: 0, stdout: `${tools[command as keyof typeof tools]}\n` };
			if (args[0] === "add" || args[0] === "install") options.onInstall?.(tools);
			return { code: 0, stdout: "" };
		},
		async ask(question, fallback) {
			asked.push(question);
			return options.answers?.[question] ?? fallback;
		},
		async confirm(question) {
			asked.push(question);
			return options.confirms ?? true;
		},
		log: (line) => lines.push(line),
	};
	return { deps, home, repoRoot, calls, asked, lines };
}

const profileOf = (home: string) => join(home, ".sitra", "profile");
const askName = "What should your agents call you?";

test("on a ready machine it sets up the profile, the packages, herdr's hook and the question guidance", async () => {
	const m = machine({ answers: { [askName]: "Sam" } });
	const result = await runInit(m.deps);
	const profile = profileOf(m.home);

	expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("# Working with Sam\n");
	expect(readConfig(join(m.home, ".sitra"))).toEqual({ name: "Sam", skills: [] });

	const piInstalls = m.calls.filter((c) => c.command === "pi" && c.args[0] === "install");
	expect(piInstalls.map((c) => c.args[1])).toEqual([...PACKAGES, m.repoRoot]);
	for (const c of piInstalls) expect(c.env?.PI_CODING_AGENT_DIR).toBe(profile);

	const hook = m.calls.find((c) => c.command === "herdr" && c.args.join(" ") === "integration install pi");
	expect(hook?.env?.PI_CODING_AGENT_DIR).toBe(profile);

	const guidance = join(m.home, ".config", "rpiv-ask-user-question", "config.json");
	expect(readFileSync(guidance, "utf8")).toContain("Ask Sam");
	expect(result.needsYou).toEqual(["Start sitra inside herdr and sign in to your model provider with /login."]);
});

test("when Pi is missing and the person says no, it installs nothing and says how to install Pi", async () => {
	const m = machine({ tools: { pi: "" }, confirms: false });
	const result = await runInit(m.deps);
	expect(m.calls.some((c) => c.args[0] === "add" || c.args[0] === "install")).toBe(false);
	expect(result.needsYou.join("\n")).toContain(`pnpm add -g ${PI_PACKAGE}@${PI_MIN}`);
});

test("when Pi is missing and the person says yes, it installs the tested version and carries on", async () => {
	const m = machine({ tools: { pi: "" }, onInstall: (tools) => Object.assign(tools, { pi: PI_MIN }) });
	await runInit(m.deps);
	expect(m.calls).toContainEqual(
		expect.objectContaining({ command: "pnpm", args: ["add", "-g", `${PI_PACKAGE}@${PI_MIN}`] }),
	);
	expect(m.calls.filter((c) => c.command === "pi" && c.args[0] === "install")).toHaveLength(PACKAGES.length + 1);
});

test("an old Pi counts as missing", async () => {
	const m = machine({ tools: { pi: "0.84.0" }, confirms: false });
	const result = await runInit(m.deps);
	expect(result.needsYou.join("\n")).toContain("0.84.0");
	expect(m.calls.some((c) => c.command === "pi" && c.args[0] === "install")).toBe(false);
});

test("without herdr it says where to get it and skips herdr's hook", async () => {
	const m = machine({ tools: { herdr: "" } });
	const result = await runInit(m.deps);
	expect(result.needsYou.join("\n")).toContain("https://herdr.dev");
	expect(m.calls.some((c) => c.command === "herdr" && c.args[0] === "integration")).toBe(false);
});

test("it keeps question guidance the person already has", async () => {
	const m = machine({});
	const guidance = join(m.home, ".config", "rpiv-ask-user-question", "config.json");
	mkdirSync(join(m.home, ".config", "rpiv-ask-user-question"), { recursive: true });
	writeFileSync(guidance, "mine\n");
	await runInit(m.deps);
	expect(readFileSync(guidance, "utf8")).toBe("mine\n");
});

test("run again, it offers the saved name and keeps the person's profile edits", async () => {
	const first = machine({ answers: { [askName]: "Sam" } });
	await runInit(first.deps);
	writeFileSync(join(profileOf(first.home), "AGENTS.md"), "edited\n");
	const fallbacks: string[] = [];
	const ask = async (_question: string, fallback: string) => {
		fallbacks.push(fallback);
		return fallback;
	};
	await runInit({ ...first.deps, ask });
	expect(fallbacks[0]).toBe("Sam");
	expect(readFileSync(join(profileOf(first.home), "AGENTS.md"), "utf8")).toBe("edited\n");
});

test("with the person's OK it shares their existing Pi sign-ins instead of asking them to log in again", async () => {
	const m = machine({});
	mkdirSync(join(m.home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(m.home, ".pi", "agent", "auth.json"), "{}");
	const result = await runInit(m.deps);
	const link = join(profileOf(m.home), "auth.json");
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
	expect(readlinkSync(link)).toBe(join(m.home, ".pi", "agent", "auth.json"));
	expect(result.needsYou).toEqual(["Start sitra inside herdr."]);
});

test("it puts sitra on the PATH in ~/.local/bin, but never replaces an existing sitra there", async () => {
	const m = machine({});
	await runInit(m.deps);
	const bin = join(m.home, ".local", "bin", "sitra");
	expect(readlinkSync(bin)).toBe(join(m.repoRoot, "bin", "sitra.ts"));

	const other = machine({});
	mkdirSync(join(other.home, ".local", "bin"), { recursive: true });
	writeFileSync(join(other.home, ".local", "bin", "sitra"), "someone else's\n");
	await runInit(other.deps);
	expect(readFileSync(join(other.home, ".local", "bin", "sitra"), "utf8")).toBe("someone else's\n");
	expect(existsSync(join(other.home, ".local", "bin", "sitra"))).toBe(true);
});

test("installs run quietly, and a failed one says what went wrong and how to retry", async () => {
	const m = machine({});
	const exec = m.deps.exec;
	m.deps.exec = (command, args, opts) =>
		command === "pi" && args[1] === "npm:pi-web-access@0.40.0"
			? { code: 1, stdout: "npm error 404 Not Found - pi-web-access\n" }
			: exec(command, args, opts);
	const result = await runInit(m.deps);
	const piInstalls = m.calls.filter((c) => c.command === "pi" && c.args[0] === "install");
	expect(piInstalls.length).toBeGreaterThan(0);
	expect(m.lines.join("\n")).not.toContain("404");
	const failure = result.needsYou.find((item) => item.includes("pi-web-access"));
	expect(failure).toContain("npm error 404 Not Found");
	expect(failure).toContain("pi install npm:pi-web-access@0.40.0");
});

test("offers to load Grimoire in Claude Code and Codex when they're set up, and leaves them alone when declined", async () => {
	const yes = machine({ answers: { [askName]: "Sam" } });
	mkdirSync(join(yes.home, ".claude"));
	mkdirSync(join(yes.home, ".codex"));
	await runInit(yes.deps);
	expect(yes.asked).toContain("Load your Grimoire in Claude Code and Codex too?");
	const claude = JSON.parse(readFileSync(join(yes.home, ".claude", "settings.json"), "utf8"));
	expect(claude.hooks.SessionStart[0].hooks[0].command).toContain("grimoire hook claude");
	const codex = JSON.parse(readFileSync(join(yes.home, ".codex", "hooks.json"), "utf8"));
	expect(codex.hooks.SessionStart[0].hooks[0].command).toContain("grimoire hook codex");

	const no = machine({ answers: { [askName]: "Sam" }, confirms: false });
	mkdirSync(join(no.home, ".claude"));
	await runInit(no.deps);
	expect(existsSync(join(no.home, ".claude", "settings.json"))).toBe(false);

	const neither = machine({ answers: { [askName]: "Sam" } });
	await runInit(neither.deps);
	expect(neither.asked).not.toContain("Load your Grimoire in Claude Code and Codex too?");
});

test("every pinned package is an exact version or commit, and web access ships by default", () => {
	for (const p of PACKAGES) expect(p).toMatch(/@(\d+\.\d+\.\d+|[0-9a-f]{40})$/);
	expect(PACKAGES).toContain("npm:pi-web-access@0.40.0");
	expect(PACKAGES).not.toContain("npm:pi-memory@0.4.2");
});

test("init does not reinstall pi-memory or rewrite a filtered pi-memory package entry", async () => {
	const m = machine({});
	const profile = profileOf(m.home);
	mkdirSync(profile, { recursive: true });
	const settings = join(profile, "settings.json");
	const filtered = '{\n\t"packages": [\n\t\t{ "source": "npm:pi-memory@0.4.2", "extensions": [] }\n\t]\n}\n';
	writeFileSync(settings, filtered);
	await runInit(m.deps);
	expect(m.calls.filter((c) => c.command === "pi" && c.args.includes("npm:pi-memory@0.4.2"))).toEqual([]);
	expect(readFileSync(settings, "utf8")).toBe(filtered);
});
