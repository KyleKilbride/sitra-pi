/** How `sitra` starts Pi: its own profile, the person's name for the lead's rules, and an optional skill allowlist. */
import { join } from "node:path";
import { type Config, profileDir, writeConfig } from "./config.ts";

export function piArgs(config: Config, args: readonly string[]): string[] {
	if (config.skills.length === 0) return [...args];
	return ["--no-skills", ...config.skills.flatMap((s) => ["--skill", s]), ...args];
}

export function piEnv(
	sitra: string,
	config: Config,
	env: Record<string, string | undefined>,
	role: "lead" | "tower" = "lead",
): Record<string, string | undefined> {
	const profile = profileDir(sitra);
	const base: Record<string, string | undefined> = {
		...env,
		PI_CODING_AGENT_DIR: profile,
		PI_MEMORY_DIR: join(profile, "memory"),
		SITRA_USER_NAME: config.name,
	};
	if (role === "tower") {
		base.SITRA_ROLE = "tower";
		base.SITRA_TOWER_NAME = config.tower?.trim() || "Tower";
	} else {
		// A lead started from a shell inside the tower's pane inherits the tower's role; it must not become a second tower.
		delete base.SITRA_ROLE;
		delete base.SITRA_TOWER_NAME;
	}
	return base;
}

/** Whether the first CLI argument starts the tower: `sitra tower` or `sitra <its personal name>` (case-insensitive). */
export function isTowerCommand(first: string | undefined, config: Config): boolean {
	if (!first) return false;
	const word = first.trim().toLowerCase();
	const custom = config.tower?.trim().toLowerCase();
	return word === "tower" || (Boolean(custom) && word === custom);
}

/** Asks the person to name their tower on its very first launch and saves the choice in config.json. */
export async function ensureTowerName(
	sitra: string,
	config: Config,
	ask: (question: string) => Promise<string>,
): Promise<Config> {
	if (config.tower?.trim()) return config;
	const answer = (await ask("Your tower needs a name before its first watch. What should we call it?")).trim();
	const tower = answer || "Tower";
	const next: Config = { ...config, tower };
	writeConfig(sitra, next);
	return next;
}
