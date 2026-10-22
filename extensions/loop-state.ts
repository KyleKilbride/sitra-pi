import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AbandonedLoopState, LoopState } from "./loop.ts";
import { abandonLoop, validateLoopState } from "./loop.ts";

export function loopStatePath(profile: string, worktree: string, branch: string): string {
	const key = createHash("sha256").update(JSON.stringify({ worktree, branch })).digest("hex");
	return join(profile, "loops", `${key}.json`);
}

export function readLoopStateFile(path: string): LoopState {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`could not read loop state ${path}: ${String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid loop state JSON ${path}: ${String(error)}`);
	}
	const valid = validateLoopState(parsed);
	if (!valid.ok) throw new Error(`invalid loop state ${path}: ${valid.reason}`);
	return valid.state;
}

export function writeLoopStateFile(path: string, state: LoopState): void {
	const valid = validateLoopState(state);
	if (!valid.ok) throw new Error(`refusing to write invalid loop state ${path}: ${valid.reason}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
}

export function abandonLoopStateFile(path: string, state: LoopState, reason: string, now = new Date()): string {
	const abandonedAt = now.toISOString();
	const key = basename(path, ".json");
	const target = join(dirname(path), "abandoned", `${key}-${abandonedAt}.json`);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(abandonLoop(state, { abandonedAt, abandonReason: reason }), null, "\t")}\n`);
	unlinkSync(path);
	return target;
}

export function readLoopMetricStateFiles(profile: string): (LoopState | AbandonedLoopState)[] {
	const dir = join(profile, "loops");
	if (!existsSync(dir)) return [];
	const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
	const active = readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => {
			const parsed = readJson(join(dir, file));
			const valid = validateLoopState(parsed);
			return valid.ok ? [valid.state] : [];
		});
	const abandonedDir = join(dir, "abandoned");
	const abandoned = existsSync(abandonedDir)
		? readdirSync(abandonedDir)
				.filter((file) => file.endsWith(".json"))
				.map((file) => readJson(join(abandonedDir, file)) as AbandonedLoopState)
		: [];
	return [...active, ...abandoned];
}
