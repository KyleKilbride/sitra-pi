/** Long commands run in a visible herdr pane with output teed to a log; agents check the log instead of waiting. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EXIT_MARKER = "__SITRA_EXIT__=";
/** First line of a run's log: the shell's pid (so a dead run is not "running" forever) and who started it. */
export const HEADER_MARKER = "__SITRA_RUN__=";

export interface RunMeta {
	label?: string;
	project?: string;
	branch?: string;
	agent?: string;
	sessionId?: string;
	command?: string;
	loop?: {
		commit: string;
		testHashes: { file: string; sha256?: string; missing?: boolean }[];
	};
}

export function hashFiles(worktree: string, files: string[]): { file: string; sha256?: string; missing?: boolean }[] {
	return files.map((file) => ({
		file,
		...(() => {
			try {
				return {
					sha256: createHash("sha256")
						.update(readFileSync(file.startsWith("/") ? file : join(worktree, file)))
						.digest("hex"),
				};
			} catch (error) {
				if ((error as { code?: unknown }).code === "ENOENT") return { missing: true };
				throw error;
			}
		})(),
	}));
}

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The line typed into the pane: record who runs it, run the command, keep a full log, record the exit code. */
export function paneCommand(command: string, log: string, meta: RunMeta = {}): string {
	const q = shellQuote(log);
	const nonce = createHash("sha256").update(`${Date.now()}:${Math.random()}:${log}`).digest("hex").slice(0, 16);
	const metaWithNonce = { ...meta, nonce };
	const head = shellQuote(`${HEADER_MARKER}{"pid":`);
	const pidStart = shellQuote(`,"pidStart":"`);
	const pidStartKind = shellQuote(`","pidStartKind":"`);
	const tail = shellQuote(`","meta":${JSON.stringify(metaWithNonce)}}`);
	// Always bash, whatever shell the pane runs (herdr panes run the user's zsh).
	const script = `pid_start=""; pid_start_kind=""; if [ -r "/proc/$$/stat" ]; then pid_start=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null || true); if [ -n "$pid_start" ]; then pid_start_kind="proc"; fi; fi; if [ -z "$pid_start" ]; then pid_start=$(ps -o lstart= -p "$$" 2>/dev/null | awk '{$1=$1; print}' || true); if [ -n "$pid_start" ]; then pid_start_kind="ps-lstart"; fi; fi; printf '%s%s%s%s%s%s%s\\n' ${head} "$$" ${pidStart} "$pid_start" ${pidStartKind} "$pid_start_kind" ${tail} > ${q}; { ${command} ; } 2>&1 | tee -a ${q}; echo "${EXIT_MARKER}${nonce}=\${PIPESTATUS[0]}" >> ${q}`;
	return `bash -c ${shellQuote(script)}`;
}

export interface RunStatus {
	done: boolean;
	exitCode?: number;
	tail: string;
}

export function readRun(logText: string, tailLines = 40): RunStatus {
	const lines = logText.replace(/\n$/, "").split("\n");
	const header = readRunHeader(lines[0] ?? "");
	if ((lines[0] ?? "").startsWith(HEADER_MARKER) && !header) throw new Error("invalid run header");
	const nonce = header?.nonce;
	const marker = lines.findLastIndex((l) =>
		nonce ? l.startsWith(`${EXIT_MARKER}${nonce}=`) : l.startsWith(EXIT_MARKER),
	);
	const body = (marker === -1 ? lines : lines.slice(0, marker)).filter((l) => !l.startsWith(HEADER_MARKER));
	const tail = body.slice(-tailLines).join("\n");
	if (marker === -1) return { done: false, tail };
	const prefix = nonce ? `${EXIT_MARKER}${nonce}=` : EXIT_MARKER;
	return { done: true, exitCode: Number(lines[marker]?.slice(prefix.length)), tail };
}

/** The pid and owner recorded on the log's first line, if the run was started by `paneCommand`. */
export function readRunHeader(
	firstLine: string,
): { pid: number; pidStart?: string; pidStartKind?: "proc" | "ps-lstart"; nonce?: string; meta: RunMeta } | undefined {
	if (!firstLine.startsWith(HEADER_MARKER)) return undefined;
	try {
		const value: unknown = JSON.parse(firstLine.slice(HEADER_MARKER.length));
		if (!value || typeof value !== "object") return undefined;
		const { pid, pidStart, pidStartKind, meta } = value as {
			pid?: unknown;
			pidStart?: unknown;
			pidStartKind?: unknown;
			meta?: Record<string, unknown>;
		};
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
		const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
		const label = text(meta?.label);
		const project = text(meta?.project);
		const branch = text(meta?.branch);
		const agent = text(meta?.agent);
		const sessionId = text(meta?.sessionId);
		const command = text(meta?.command);
		const nonce = text(meta?.nonce);
		const loop =
			meta?.loop &&
			typeof meta.loop === "object" &&
			typeof (meta.loop as { commit?: unknown }).commit === "string" &&
			Array.isArray((meta.loop as { testHashes?: unknown }).testHashes) &&
			(meta.loop as { testHashes: unknown[] }).testHashes.every(
				(item) =>
					item &&
					typeof item === "object" &&
					typeof (item as { file?: unknown }).file === "string" &&
					(typeof (item as { sha256?: unknown }).sha256 === "string" ||
						(item as { missing?: unknown }).missing === true),
			)
				? {
						commit: (meta.loop as { commit: string }).commit.slice(0, 200),
						testHashes: (meta.loop as { testHashes: { file: string; sha256?: string; missing?: boolean }[] }).testHashes.map((item) => ({
							file: item.file.slice(0, 500),
							...(item.sha256 ? { sha256: item.sha256.slice(0, 200) } : {}),
							...(item.missing === true ? { missing: true } : {}),
						})),
					}
				: undefined;
		const pidStartText = text(pidStart);
		const rawKind = text(pidStartKind);
		const inferredKind =
			rawKind === "proc" || rawKind === "ps-lstart"
				? rawKind
				: pidStartText && Array.from(pidStartText).every((ch) => ch >= "0" && ch <= "9")
					? "proc"
					: undefined;
		return {
			pid,
			...(pidStartText ? { pidStart: pidStartText } : {}),
			...(pidStartText && inferredKind ? { pidStartKind: inferredKind } : {}),
			...(nonce ? { nonce } : {}),
			meta: {
				...(label ? { label } : {}),
				...(project ? { project } : {}),
				...(branch ? { branch } : {}),
				...(agent ? { agent } : {}),
				...(sessionId ? { sessionId } : {}),
				...(command ? { command } : {}),
				...(loop ? { loop } : {}),
			},
		};
	} catch {
		return undefined;
	}
}
