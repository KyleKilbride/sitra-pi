/** How `sitra` starts Pi: its own profile, the person's name for the lead's rules, and an optional skill allowlist. */
import { join } from "node:path";
import { type Config, profileDir } from "./config.ts";

export function piArgs(config: Config, args: readonly string[]): string[] {
	if (config.skills.length === 0) return [...args];
	return ["--no-skills", ...config.skills.flatMap((s) => ["--skill", s]), ...args];
}

export function piEnv(
	sitra: string,
	config: Config,
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const profile = profileDir(sitra);
	return { ...env, PI_CODING_AGENT_DIR: profile, PI_MEMORY_DIR: join(profile, "memory"), SITRA_USER_NAME: config.name };
}
