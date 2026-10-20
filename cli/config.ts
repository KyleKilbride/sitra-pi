/** Where sitra keeps its own state: ~/.sitra (or $SITRA_HOME), holding config.json and the Pi profile. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	/** What the agents call the person they work with. */
	name: string;
	/** Skill folders to load. Empty means Pi's normal skill discovery. */
	skills: string[];
	/** Personal name given to the tower (the person's number 2) on its first launch. */
	tower?: string;
	/** Optional command prefix to launch the tower (e.g. a local connector wrapper) instead of plain `pi`. */
	towerCommand?: string[];
	/** Whether Grimoire learns from corrections in the background (default on). */
	learn?: boolean;
	/** The model the background learner asks (default `google/gemini-4-argon`). */
	learnModel?: string;
}

/** The environment that carries the learning settings to Pi sessions and hooks. */
export function learnEnv(config: Config): Record<string, string> {
	return {
		...(config.learn === false ? { SITRA_GRIMOIRE_LEARN: "0" } : {}),
		...(config.learnModel?.trim() ? { SITRA_LEARN_MODEL: config.learnModel.trim() } : {}),
	};
}

export function sitraHome(env: Record<string, string | undefined>, home: string): string {
	const raw = env.SITRA_HOME || join(home, ".sitra");
	return existsSync(raw) ? realpathSync(raw) : raw;
}

export function profileDir(sitra: string): string {
	return join(sitra, "profile");
}

export function readConfig(sitra: string): Config {
	const file = join(sitra, "config.json");
	if (!existsSync(file)) return { name: "", skills: [] };
	const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
	const base: Config = {
		name: raw.name ?? "",
		skills: raw.skills ?? [],
		...(Array.isArray(raw.towerCommand) && raw.towerCommand.length > 0 ? { towerCommand: raw.towerCommand } : {}),
		...(typeof raw.learn === "boolean" ? { learn: raw.learn } : {}),
		...(typeof raw.learnModel === "string" && raw.learnModel.trim() ? { learnModel: raw.learnModel.trim() } : {}),
	};
	return raw.tower?.trim() ? { ...base, tower: raw.tower.trim() } : base;
}

export function writeConfig(sitra: string, config: Config): void {
	mkdirSync(sitra, { recursive: true });
	writeFileSync(join(sitra, "config.json"), `${JSON.stringify(config, null, "\t")}\n`);
}
