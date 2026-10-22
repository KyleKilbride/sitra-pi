import { execFileSync } from "node:child_process";

export function dirtyFiles(cwd: string): string[] {
	const raw = execFileSync("git", ["status", "--porcelain", "-z"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const entries = raw.split("\0").filter(Boolean);
	const dirty: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index] ?? "";
		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		if (status.includes("R") || status.includes("C")) {
			const oldPath = entries[index + 1];
			index += 1;
			dirty.push(oldPath ? `${oldPath} -> ${path}` : path);
			continue;
		}
		dirty.push(path);
	}
	return dirty;
}

export function worktreeClean(cwd: string): boolean {
	return dirtyFiles(cwd).length === 0;
}
