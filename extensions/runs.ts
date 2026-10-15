/** Long commands run in a visible herdr pane with output teed to a log; agents check the log instead of waiting. */
export const EXIT_MARKER = "__SITRA_EXIT__=";

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The line typed into the pane: run the command, keep a full log, record the exit code. */
export function paneCommand(command: string, log: string): string {
	const q = shellQuote(log);
	// Always bash, whatever shell the pane runs (herdr panes run the user's zsh).
	const script = `{ ${command} ; } 2>&1 | tee ${q}; echo "${EXIT_MARKER}\${PIPESTATUS[0]}" >> ${q}`;
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
	const body = marker === -1 ? lines : lines.slice(0, marker);
	const tail = body.slice(-tailLines).join("\n");
	if (marker === -1) return { done: false, tail };
	return { done: true, exitCode: Number(lines[marker]?.slice(EXIT_MARKER.length)), tail };
}
