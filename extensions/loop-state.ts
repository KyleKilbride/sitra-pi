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

export function readLoopMetricStateFiles(profile: string): {
	states: (LoopState | AbandonedLoopState)[];
	badFiles: string[];
} {
	const dir = join(profile, "loops");
	if (!existsSync(dir)) return { states: [], badFiles: [] };
	const badFiles: string[] = [];
	const readJson = (path: string, label: string): unknown | undefined => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			badFiles.push(label);
			return undefined;
		}
	};
	const active = readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => {
			const parsed = readJson(join(dir, file), file);
			if (!parsed) return [];
			const valid = validateLoopState(parsed);
			if (valid.ok) return [valid.state];
			badFiles.push(file);
			return [];
		});
	const abandonedDir = join(dir, "abandoned");
	const abandoned = existsSync(abandonedDir)
		? readdirSync(abandonedDir)
				.filter((file) => file.endsWith(".json"))
				.flatMap((file) => {
					const label = `abandoned/${file}`;
					const parsed = readJson(join(abandonedDir, file), label);
					if (!parsed || typeof parsed !== "object") return [];
					const { abandonedAt, abandonReason: _abandonReason, ...activeState } = parsed as Record<string, unknown>;
					const valid = validateLoopState(activeState);
					if (typeof abandonedAt === "string" && valid.ok) return [parsed as AbandonedLoopState];
					badFiles.push(label);
					return [];
				})
		: [];
	return { states: [...active, ...abandoned], badFiles };
}
