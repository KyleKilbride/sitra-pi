/**
 * A small, strict reader for the shell lines agents run: which commands a line executes (including ones inside
 * `bash -c '…'`, `( … )`, `$( … )`, backticks, `<( … )` and unquoted heredocs) and which files it writes (`>`, `>>`,
 * `&>`, `tee`, `sed -i`). Quoted text, quoted heredoc bodies and comments are data, never commands.
 *
 * One recursive reader handles every nesting, so quotes, comments and heredocs mean the same thing at every depth.
 * A nested part only counts once it closes properly; a line it can't fully read keeps only the commands that finished
 * before the problem. It never guesses.
 */

export interface ShellRead {
	/** Each executed command as its words, quotes removed, redirections taken out. */
	commands: string[][];
	/** Files the line writes. */
	writes: string[];
}

const MAX_DEPTH = 4;
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const WRAPPERS = new Set(["env", "time", "command", "nohup", "sudo", "exec", "do", "then", "else", "!", "{"]);
/** Characters a backslash escapes inside double quotes; before anything else the backslash stays. */
const DQ_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

/** The command's words without leading `VAR=value` settings and wrappers (`env`, `time`, `timeout N`, `rtk proxy`, …). */
export function stripWrappers(words: readonly string[]): string[] {
	let i = 0;
	while (i < words.length) {
		const w = words[i] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
		else if (w === "timeout" && /^\d/.test(words[i + 1] ?? "")) i += 2;
		else if (w === "rtk" && words[i + 1] === "proxy") i += 2;
		else break;
	}
	return words.slice(i);
}

interface Parsed {
	read: ShellRead;
	/** Index just past the closing `)` or backtick (or the end of the text at the top level). */
	end: number;
	ok: boolean;
}

/** A heredoc delimiter after `<<`: quote removal applied, and whether any of it was quoted. */
function heredocDelimiter(src: string, start: number): { delim: string; quoted: boolean; end: number } | undefined {
	let i = start;
	let delim = "";
	let quoted = false;
	while (i < src.length && !/[\s;&|<>()]/.test(src[i] as string)) {
		const ch = src[i] as string;
		if (ch === "'" || ch === '"') {
			const close = src.indexOf(ch, i + 1);
			if (close === -1) return undefined;
			delim += src.slice(i + 1, close);
			quoted = true;
			i = close + 1;
		} else if (ch === "\\") {
			delim += src[i + 1] ?? "";
			quoted = true;
			i += 2;
		} else {
			delim += ch;
			i++;
		}
	}
	return delim ? { delim, quoted, end: i } : undefined;
}

function parse(src: string, start: number, stop: ")" | "`" | undefined, depth: number): Parsed {
	const done: ShellRead = { commands: [], writes: [] };
	let pending: ShellRead = { commands: [], writes: [] };
	let words: string[] = [];
	let word: string | undefined;
	let target: "write" | "skip" | undefined;
	const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];
	const record = depth <= MAX_DEPTH;

	const fail = (): Parsed => ({ read: done, end: src.length, ok: false });
	const add = (into: ShellRead, from: ShellRead) => {
		into.commands.push(...from.commands);
		into.writes.push(...from.writes);
	};
	/** Reads a nested part starting at `at`; returns its end, or -1 if it never closes. */
	const nested = (at: number, close: ")" | "`"): number => {
		const r = parse(src, at, close, depth + 1);
		if (!r.ok) return -1;
		add(pending, r.read);
		return r.end;
	};
	const endWord = () => {
		if (word === undefined) return;
		if (target === "write") pending.writes.push(word);
		else if (target !== "skip") words.push(word);
		target = undefined;
		word = undefined;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) {
			pending.commands.push(words);
			afterCommand(words, pending, depth);
		}
		words = [];
		if (record) add(done, pending);
		pending = { commands: [], writes: [] };
	};
	/** Substitutions in an unquoted heredoc body run; everything else in it is text. */
	const scanBody = (body: string) => {
		for (let j = 0; j < body.length; j++) {
			if (body[j] === "\\") j++;
			else if (body[j] === "$" && body[j + 1] === "(") {
				const r = parse(body, j + 2, ")", depth + 1);
				if (r.ok && record) add(done, r.read);
				if (r.ok) j = r.end - 1;
			} else if (body[j] === "`") {
				const r = parse(body, j + 1, "`", depth + 1);
				if (r.ok && record) add(done, r.read);
				if (r.ok) j = r.end - 1;
			}
		}
	};

	let i = start;
	while (i < src.length) {
		const ch = src[i] as string;
		if (stop && ch === stop) {
			endCommand();
			return { read: done, end: i + 1, ok: true };
		}
		if (ch === " " || ch === "\t") {
			endWord();
			i++;
		} else if (ch === "\n") {
			endCommand();
			i++;
			for (const h of heredocs.splice(0)) {
				const lines: string[] = [];
				while (i < src.length) {
					const nl = src.indexOf("\n", i);
					const line = src.slice(i, nl === -1 ? src.length : nl);
					i = nl === -1 ? src.length : nl + 1;
					if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
					lines.push(line);
				}
				if (!h.quoted) scanBody(lines.join("\n"));
			}
		} else if (ch === "#" && word === undefined) {
			const nl = src.indexOf("\n", i);
			i = nl === -1 ? src.length : nl;
		} else if (ch === "\\") {
			if (src[i + 1] !== "\n") word = (word ?? "") + (src[i + 1] ?? "");
			i += 2;
		} else if (ch === "'") {
			const close = src.indexOf("'", i + 1);
			if (close === -1) return fail();
			word = (word ?? "") + src.slice(i + 1, close);
			i = close + 1;
		} else if (ch === '"') {
			let text = "";
			let j = i + 1;
			while (j < src.length && src[j] !== '"') {
				const c = src[j] as string;
				if (c === "\\") {
					const next = src[j + 1] ?? "";
					text += DQ_ESCAPES.has(next) ? (next === "\n" ? "" : next) : `\\${next}`;
					j += 2;
				} else if (c === "$" && src[j + 1] === "(") {
					const end = nested(j + 2, ")");
					if (end === -1) return fail();
					text += src.slice(j, end);
					j = end;
				} else if (c === "`") {
					const end = nested(j + 1, "`");
					if (end === -1) return fail();
					text += src.slice(j, end);
					j = end;
				} else {
					text += c;
					j++;
				}
			}
			if (j >= src.length) return fail();
			word = (word ?? "") + text;
			i = j + 1;
		} else if (ch === "$" && src[i + 1] === "(") {
			const end = nested(i + 2, ")");
			if (end === -1) return fail();
			word = (word ?? "") + src.slice(i, end);
			i = end;
		} else if (ch === "`") {
			const end = nested(i + 1, "`");
			if (end === -1) return fail();
			word = (word ?? "") + src.slice(i, end);
			i = end;
		} else if ((ch === "<" || ch === ">") && src[i + 1] === "(" && word === undefined) {
			const end = nested(i + 2, ")");
			if (end === -1) return fail();
			word = src.slice(i, end);
			i = end;
		} else if (ch === "(" && word === undefined && words.length === 0) {
			const end = nested(i + 1, ")");
			if (end === -1) return fail();
			i = end;
		} else if (ch === ")" || ch === ";" || ch === "|" || (ch === "&" && src[i + 1] !== ">")) {
			endCommand();
			const two = src.slice(i, i + 2);
			i += two === "&&" || two === "||" || two === "|&" || two === ";;" ? 2 : 1;
		} else if (ch === ">" || (ch === "&" && src[i + 1] === ">")) {
			// `2>`: the digits before `>` are a descriptor, not a word.
			if (word !== undefined && /^\d+$/.test(word)) word = undefined;
			else endWord();
			i += ch === "&" ? 2 : 1;
			if (src[i] === ">" || src[i] === "|") i++;
			if (src[i] === "&") {
				i++;
				target = "skip"; // `>&2`, `2>&1`: into another descriptor, not a file.
			} else target = "write";
		} else if (ch === "<") {
			if (word !== undefined && /^\d+$/.test(word)) word = undefined;
			else endWord();
			if (src.startsWith("<<<", i)) {
				i += 3;
				target = "skip";
			} else if (src.startsWith("<<", i)) {
				i += 2;
				const strip = src[i] === "-";
				if (strip) i++;
				while (src[i] === " " || src[i] === "\t") i++;
				const d = heredocDelimiter(src, i);
				if (!d) return fail();
				heredocs.push({ delim: d.delim, quoted: d.quoted, strip });
				i = d.end;
			} else {
				i++;
				if (src[i] === ">" || src[i] === "&") i++;
				target = "skip";
			}
		} else {
			word = (word ?? "") + ch;
			i++;
		}
	}
	if (stop) return fail();
	endCommand();
	return { read: done, end: src.length, ok: true };
}

/** Commands a finished command runs in turn (`bash -c '…'`), and files it writes (`tee`, `sed -i`). */
function afterCommand(cmd: readonly string[], into: ShellRead, depth: number): void {
	const w = stripWrappers(cmd);
	const flag = w.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x));
	if (SHELLS.has(w[0] ?? "") && flag !== -1 && w[flag + 1] !== undefined) {
		const r = readShell(w[flag + 1] as string, depth + 1);
		into.commands.push(...r.commands);
		into.writes.push(...r.writes);
	}
	if (w[0] === "tee") into.writes.push(...w.slice(1).filter((x) => !x.startsWith("-")));
	if (w[0] === "sed" && w.some((x) => /^-i/.test(x) || x === "--in-place")) {
		const files: string[] = [];
		for (let k = 1; k < w.length; k++) {
			const x = w[k] as string;
			if (x === "-e" || x === "-f") k++;
			else if (!x.startsWith("-") && x !== "") files.push(x);
		}
		if (!w.includes("-e") && !w.includes("-f")) files.shift();
		into.writes.push(...files);
	}
}

export function readShell(src: string, depth = 0): ShellRead {
	if (depth > MAX_DEPTH) return { commands: [], writes: [] };
	const { read } = parse(src, 0, undefined, depth);
	return {
		commands: read.commands,
		writes: read.writes.filter((p) => p !== "" && p !== "/dev/null" && !p.startsWith("$") && !/^[<>]\(/.test(p)),
	};
}
