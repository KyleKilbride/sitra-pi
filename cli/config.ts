/** Where sitra keeps its own state: ~/.sitra (or $SITRA_HOME), holding config.json and the Pi profile. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	/** What the agents call the person they work with. */
	name: string;
	/** Skill folders to load. Empty means Pi's normal skill discovery. */
	skills: string[];
}

export function sitraHome(env: Record<string, string | undefined>, home: string): string {
	return env.SITRA_HOME || join(home, ".sitra");
}

export function profileDir(sitra: string): string {
	return join(sitra, "profile");
}

export function readConfig(sitra: string): Config {
	const file = join(sitra, "config.json");
	if (!existsSync(file)) return { name: "", skills: [] };
	const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
	return { name: raw.name ?? "", skills: raw.skills ?? [] };
}

export function writeConfig(sitra: string, config: Config): void {
	mkdirSync(sitra, { recursive: true });
	writeFileSync(join(sitra, "config.json"), `${JSON.stringify(config, null, "\t")}\n`);
}
