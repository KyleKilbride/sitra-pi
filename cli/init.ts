import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { profileDir, readConfig, sitraHome, writeConfig } from "./config.ts";
import { installGrimoireHooks } from "./grimoire.ts";
import { fillTemplate, scaffoldProfile } from "./profile.ts";
import { atLeast, parseVersion } from "./versions.ts";

/**
 * `sitra init`: checks the tools sitra needs (Node, Pi, herdr), installs what it can with the person's OK, and sets up
 * the sitra profile. Safe to run again: it never overwrites files the person already has.
 */

export const NODE_MIN = "24.12.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** The Pi version sitra is tested with; older ones are refused, newer ones are allowed. */
export const PI_MIN = "1.0.0";
export const HERDR_MIN = "0.9.1";
export const HERDR_URL = "https://herdr.dev";

/** Pi packages sitra builds on, pinned (each released more than 7 days before it was pinned). */
export const PACKAGES = [
	"npm:@juicesharp/rpiv-ask-user-question@2.12.0",
	"npm:@juicesharp/rpiv-todo@2.12.0",
	"npm:pi-powerline-footer@0.20.1",
	"npm:pi-web-access@0.40.0",
	"git:github.com/edxeth/pi-subagents@cf6dbf41c17986f3882e6804a68e8fb8282d25e6",
];

export type Env = Record<string, string | undefined>;

export interface ExecResult {
	code: number;
	stdout: string;
}

export interface InitDeps {
	/** The person's home directory. */
	home: string;
	env: Env;
	/** This repo's root: the sitra Pi package, its templates and bin/sitra.ts. */
	repoRoot: string;
	nodeVersion: string;
	/** Runs a command; a command that isn't installed returns code 127. `show` streams its output to the person. */
	exec(command: string, args: string[], options?: { env?: Env; show?: boolean }): ExecResult;
	ask(question: string, fallback: string): Promise<string>;
	confirm(question: string): Promise<boolean>;
	log(line: string): void;
}

export interface InitResult {
	/** Things only the person can do, in plain words. Empty when sitra is ready. */
	needsYou: string[];
}

function versionOf(deps: InitDeps, tool: string): string | undefined {
	const result = deps.exec(tool, ["--version"]);
	return result.code === 0 ? parseVersion(result.stdout) : undefined;
}

function piInstallCommand(deps: InitDeps): string[] {
	const pkg = `${PI_PACKAGE}@${PI_MIN}`;
	return versionOf(deps, "pnpm") ? ["pnpm", "add", "-g", pkg] : ["npm", "install", "-g", pkg];
}

/** Pi, at PI_MIN or newer, installing it with the person's OK. Undefined when it still isn't there. */
async function ensurePi(deps: InitDeps, needsYou: string[]): Promise<string | undefined> {
	let pi = versionOf(deps, "pi");
	if (pi && atLeast(pi, PI_MIN)) return pi;
	const problem = pi ? `Pi ${pi} is older than ${PI_MIN}` : "Pi isn't installed";
	const install = piInstallCommand(deps);
	if (await deps.confirm(`${problem}. Install Pi ${PI_MIN} now with \`${install.join(" ")}\`?`)) {
		const [command = "", ...args] = install;
		deps.exec(command, args, { show: true });
		pi = versionOf(deps, "pi");
		if (pi && atLeast(pi, PI_MIN)) return pi;
	}
	needsYou.push(`${problem}. Install it with: ${install.join(" ")}`);
	return undefined;
}

function ensureHerdr(deps: InitDeps, needsYou: string[]): boolean {
	const herdr = versionOf(deps, "herdr");
	if (!herdr) needsYou.push(`Install herdr (${HERDR_MIN} or newer) from ${HERDR_URL}, then run sitra init again.`);
	else if (!atLeast(herdr, HERDR_MIN))
		needsYou.push(`herdr ${herdr} is older than ${HERDR_MIN}. Update it with: herdr update`);
	else return true;
	return false;
}

/** Links the person's normal Pi sign-ins into the profile, with their OK, so they don't log in twice. */
async function shareSignIns(deps: InitDeps, profile: string): Promise<boolean> {
	if (existsSync(join(profile, "auth.json"))) return true;
	const normal = join(deps.home, ".pi", "agent");
	if (!existsSync(join(normal, "auth.json"))) return false;
	if (!(await deps.confirm("Use the sign-ins from your normal Pi setup (~/.pi/agent) in sitra too?"))) return false;
	for (const file of ["auth.json", "mcp-auth.json", "models-store.json"]) {
		if (existsSync(join(normal, file)) && !existsSync(join(profile, file)))
			symlinkSync(join(normal, file), join(profile, file));
	}
	return true;
}

/** The question tool's guidance (one question at a time, context inside it), unless the person has their own. */
function writeQuestionGuidance(deps: InitDeps, name: string): void {
	const xdg = deps.env.XDG_CONFIG_HOME?.trim();
	const configDir = xdg && isAbsolute(xdg) ? xdg : join(deps.home, ".config");
	const file = join(configDir, "rpiv-ask-user-question", "config.json");
	if (existsSync(file)) {
		deps.log(`Kept your question guidance in ${file}.`);
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	const template = readFileSync(join(deps.repoRoot, "templates", "rpiv-ask-user-question.json"), "utf8");
	writeFileSync(file, fillTemplate(template, { name }));
	deps.log(`Set the question tool to ask one question at a time (${file}).`);
}

function linkCommand(deps: InitDeps, needsYou: string[]): void {
	const binDir = join(deps.home, ".local", "bin");
	const link = join(binDir, "sitra");
	const target = join(deps.repoRoot, "bin", "sitra.ts");
	let present = true;
	try {
		lstatSync(link);
	} catch {
		present = false;
	}
	if (present) {
		deps.log(`Left the existing ${link} alone.`);
	} else {
		mkdirSync(binDir, { recursive: true });
		symlinkSync(target, link);
		deps.log(`Linked the sitra command: ${link}`);
	}
	if (!(deps.env.PATH ?? "").split(":").includes(binDir)) needsYou.push(`Add ${binDir} to your PATH.`);
}

export async function runInit(deps: InitDeps): Promise<InitResult> {
	const needsYou: string[] = [];
	const { log } = deps;
	const sitra = sitraHome(deps.env, deps.home);
	const profile = profileDir(sitra);
	const inProfile = { ...deps.env, PI_CODING_AGENT_DIR: profile };

	if (atLeast(deps.nodeVersion, NODE_MIN)) log(`✓ Node ${deps.nodeVersion}`);
	else needsYou.push(`Update Node to ${NODE_MIN} or newer (you have ${deps.nodeVersion}).`);
	const pi = await ensurePi(deps, needsYou);
	if (pi) log(`✓ Pi ${pi}`);
	const herdrReady = ensureHerdr(deps, needsYou);
	if (herdrReady) log("✓ herdr");

	const config = readConfig(sitra);
	const name = (await deps.ask("What should your agents call you?", config.name)).trim();
	writeConfig(sitra, { ...config, name });
	const who = name || "the user";

	const scaffold = scaffoldProfile(join(deps.repoRoot, "templates", "profile"), profile, { name: who });
	log(`Profile ${profile}: ${scaffold.created.length} files added, ${scaffold.kept.length} of yours kept.`);
	const signedIn = await shareSignIns(deps, profile);

	if (pi) {
		for (const source of [...PACKAGES, deps.repoRoot]) {
			log(`Installing ${source} …`);
			const result = deps.exec("pi", ["install", source], { env: inProfile });
			if (result.code !== 0) {
				const output = result.stdout.trim().split("\n").slice(-3).join("\n");
				needsYou.push(
					`Pi couldn't install ${source}:\n${output}\nTry again with: PI_CODING_AGENT_DIR=${profile} pi install ${source}`,
				);
			}
		}
	}
	if (herdrReady) {
		const hook = deps.exec("herdr", ["integration", "install", "pi"], { env: inProfile });
		if (hook.code === 0) log("✓ herdr can see sitra's agents");
		else
			needsYou.push(`herdr couldn't add its Pi hook. Run: PI_CODING_AGENT_DIR=${profile} herdr integration install pi`);
	}
	writeQuestionGuidance(deps, who);
	linkCommand(deps, needsYou);
	const otherTools = ["claude", "codex"].some((t) => existsSync(join(deps.home, `.${t}`)));
	if (otherTools && (await deps.confirm("Load your Grimoire in Claude Code and Codex too?"))) {
		installGrimoireHooks(deps, join(profile, "grimoire"));
	}

	needsYou.push(
		signedIn ? "Start sitra inside herdr." : "Start sitra inside herdr and sign in to your model provider with /login.",
	);
	return { needsYou };
}
