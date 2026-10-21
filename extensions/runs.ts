/** Long commands run in a visible herdr pane with output teed to a log; agents check the log instead of waiting. */
export const EXIT_MARKER = "__SITRA_EXIT__=";
/** First line of a run's log: the shell's pid (so a dead run is not "running" forever) and who started it. */
export const HEADER_MARKER = "__SITRA_RUN__=";

export interface RunMeta {
	label?: string;
	project?: string;
	branch?: string;
	agent?: string;
	sessionId?: string;
}

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The line typed into the pane: record who runs it, run the command, keep a full log, record the exit code. */
export function paneCommand(command: string, log: string, meta: RunMeta = {}): string {
	const q = shellQuote(log);
	const head = shellQuote(`${HEADER_MARKER}{"pid":`);
	const pidStart = shellQuote(`,"pidStart":"`);
	const tail = shellQuote(`","meta":${JSON.stringify(meta)}}`);
	// Always bash, whatever shell the pane runs (herdr panes run the user's zsh).
	const script = `pid_start=""; if [ -r "/proc/$$/stat" ]; then pid_start=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null || true); fi; printf '%s%s%s%s%s\\n' ${head} "$$" ${pidStart} "$pid_start" ${tail} > ${q}; { ${command} ; } 2>&1 | tee -a ${q}; echo "${EXIT_MARKER}\${PIPESTATUS[0]}" >> ${q}`;
	return `bash -c ${shellQuote(script)}`;
}

export interface RunStatus {
	done: boolean;
	exitCode?: number;
	tail: string;
}

export function readRun(logText: string, tailLines = 40): RunStatus {
	const lines = logText.replace(/\n$/, "").split("\n");
	const marker = lines.findLastIndex((l) => l.startsWith(EXIT_MARKER));
	const body = (marker === -1 ? lines : lines.slice(0, marker)).filter((l) => !l.startsWith(HEADER_MARKER));
	const tail = body.slice(-tailLines).join("\n");
	if (marker === -1) return { done: false, tail };
	return { done: true, exitCode: Number(lines[marker]?.slice(EXIT_MARKER.length)), tail };
}

/** The pid and owner recorded on the log's first line, if the run was started by `paneCommand`. */
export function readRunHeader(firstLine: string): { pid: number; pidStart?: string; meta: RunMeta } | undefined {
	if (!firstLine.startsWith(HEADER_MARKER)) return undefined;
	try {
		const value: unknown = JSON.parse(firstLine.slice(HEADER_MARKER.length));
		if (!value || typeof value !== "object") return undefined;
		const { pid, pidStart, meta } = value as { pid?: unknown; pidStart?: unknown; meta?: Record<string, unknown> };
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
		const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
		const label = text(meta?.label);
		const project = text(meta?.project);
		const branch = text(meta?.branch);
		const agent = text(meta?.agent);
		const sessionId = text(meta?.sessionId);
		const pidStartText = text(pidStart);
		return {
			pid,
			...(pidStartText !== undefined ? { pidStart: pidStartText } : {}),
			meta: {
				...(label ? { label } : {}),
				...(project ? { project } : {}),
				...(branch ? { branch } : {}),
				...(agent ? { agent } : {}),
				...(sessionId ? { sessionId } : {}),
			},
		};
	} catch {
		return undefined;
	}
}
