import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type ListedName = { tokens: string[]; line: number };
type ForbiddenList = { names: ListedName[]; allow: string[][] };
type Hit = { file: string; line: number; listLine: number };
type FoundList = { path?: string; text?: string; tried: string[] };

const SCANNED_DIRS = ["test/", "extensions/", "cli/", "bin/", "docs/", "templates/"];
const SCANNED_FILES = ["README.md", "AGENTS.md", "package.json"];

const SEPARATOR = "\0";

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t !== "");
}

function parseList(text: string): ForbiddenList {
	const list: ForbiddenList = { names: [], allow: [] };
	text.split(/\r?\n/).forEach((raw, index) => {
		const allow = /^\s*allow:(.*)$/i.exec(raw);
		const tokens = tokenize(allow ? (allow[1] ?? "") : raw);
		if (tokens.length === 0) return;
		if (allow) list.allow.push(tokens);
		else list.names.push({ tokens, line: index + 1 });
	});
	list.allow.sort((x, y) => y.length - x.length);
	return list;
}

function listPaths(env: Record<string, string | undefined>, home = homedir()): string[] {
	const file = env.SITRA_FORBIDDEN_NAMES_FILE?.trim();
	if (file) return [file];
	const profile = env.PI_CODING_AGENT_DIR?.trim() || join(env.SITRA_HOME?.trim() || join(home, ".sitra"), "profile");
	return [join(profile, "white-label-names.txt")];
}

function findList(env: Record<string, string | undefined>, home = homedir()): FoundList {
	const tried = listPaths(env, home);
	for (const path of tried) {
		if (existsSync(path)) return { path, text: readFileSync(path, "utf8"), tried };
	}
	return { tried };
}

function skipNote(tried: string[]): string {
	return `no forbidden-names list at ${tried.join(", ")}; set SITRA_FORBIDDEN_NAMES_FILE to run the white-label check`;
}

function indexOfSequence(tokens: string[], sequence: string[], from = 0): number {
	for (let i = from; i + sequence.length <= tokens.length; i++) {
		if (sequence.every((t, j) => tokens[i + j] === t)) return i;
	}
	return -1;
}

function withoutAllowed(tokens: string[], allow: string[][]): string[] {
	let result = tokens;
	for (const phrase of allow) {
		let at = indexOfSequence(result, phrase);
		while (at !== -1) {
			result = [...result.slice(0, at), SEPARATOR, ...result.slice(at + phrase.length)];
			at = indexOfSequence(result, phrase, at + 1);
		}
	}
	return result;
}

function scanFiles(root: string, files: string[], list: ForbiddenList): Hit[] {
	const hits: Hit[] = [];
	for (const file of files) {
		readFileSync(join(root, file), "utf8")
			.split(/\r?\n/)
			.forEach((text, index) => {
				const tokens = withoutAllowed(tokenize(text), list.allow);
				for (const name of list.names) {
					if (indexOfSequence(tokens, name.tokens) !== -1) hits.push({ file, line: index + 1, listLine: name.line });
				}
			});
	}
	return hits;
}

function describeHit(hit: Hit): string {
	return `${hit.file}:${hit.line} matches a forbidden name (list line ${hit.listLine})`;
}

const trackedFiles = (root: string): string[] =>
	execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((f) => SCANNED_FILES.includes(f) || SCANNED_DIRS.some((d) => f.startsWith(d)));

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-white-label-")));

describe("white-label helper self-tests (made-up names only)", () => {
	const setup = (names: string, files: Record<string, string>) => {
		const dir = tmp();
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
		return { dir, list: parseList(names), files: Object.keys(files) };
	};

	test("a listed name in a file fails with file:line and the list line, never the name", () => {
		const { dir, list, files } = setup("Other Thing\nQuillfeather Labs\n", {
			"notes.md": "first line\nsecond line mentions quillfeather-labs here\n",
		});
		const hits = scanFiles(dir, files, list);
		expect(hits).toEqual([{ file: "notes.md", line: 2, listLine: 2 }]);
		const message = hits.map(describeHit).join("\n");
		expect(message).toContain("notes.md:2");
		expect(message).toContain("list line 2");
		expect(message.toLowerCase()).not.toContain("quillfeather");
		expect(message.toLowerCase()).not.toContain("labs");
	});

	test("an allow: phrase containing the name passes, and only where it is allowed", () => {
		const names = "Quillfeather Labs\nallow: github.com/someone/quillfeather-labs-pi\n";
		const allowed = setup(names, { "a.json": '{"url": "git+https://github.com/someone/quillfeather-labs-pi.git"}\n' });
		expect(scanFiles(allowed.dir, allowed.files, allowed.list)).toEqual([]);

		const mixed = setup(names, {
			"b.md": "see github.com/someone/quillfeather-labs-pi, built by Quillfeather Labs\n",
		});
		expect(scanFiles(mixed.dir, mixed.files, mixed.list)).toEqual([{ file: "b.md", line: 1, listLine: 1 }]);
	});

	test("matches token sequences ignoring case and punctuation, not partial tokens or split sequences", () => {
		const { dir, list, files } = setup("Zorblax Tools\n", {
			"yes.md": "ZORBLAX/tools\n",
			"no.md": "zorblaxes tools\nzorblax\ntools\n",
		});
		expect(scanFiles(dir, files, list)).toEqual([{ file: "yes.md", line: 1, listLine: 1 }]);
		expect(tokenize("Demo-App_v2 › pi")).toEqual(["demo", "app", "v2", "pi"]);
	});

	test("an allow: phrase never glues the text around it into a match", () => {
		const { dir, list, files } = setup("alpha beta\nallow: middle\n", {
			"c.md": "alpha middle beta\n",
			"d.md": "alpha beta\n",
		});
		expect(scanFiles(dir, files, list)).toEqual([{ file: "d.md", line: 1, listLine: 1 }]);
	});

	test("the list comes from SITRA_FORBIDDEN_NAMES_FILE, else the profile, in the grimoireDir order", () => {
		const home = "/home/someone";
		expect(listPaths({ SITRA_FORBIDDEN_NAMES_FILE: "/x/names.txt", PI_CODING_AGENT_DIR: "/p" }, home)).toEqual([
			"/x/names.txt",
		]);
		expect(listPaths({ PI_CODING_AGENT_DIR: "/p", SITRA_HOME: "/s" }, home)).toEqual(["/p/white-label-names.txt"]);
		expect(listPaths({ SITRA_HOME: "/s" }, home)).toEqual(["/s/profile/white-label-names.txt"]);
		expect(listPaths({}, home)).toEqual(["/home/someone/.sitra/profile/white-label-names.txt"]);
	});

	test("no list means no result and a note naming every path tried", () => {
		const dir = tmp();
		const missing = join(dir, "nope.txt");
		const found = findList({ SITRA_FORBIDDEN_NAMES_FILE: missing }, dir);
		expect(found.text).toBeUndefined();
		expect(found.tried).toEqual([missing]);
		expect(skipNote(found.tried)).toBe(
			`no forbidden-names list at ${missing}; set SITRA_FORBIDDEN_NAMES_FILE to run the white-label check`,
		);

		const viaHome = findList({}, dir);
		expect(viaHome.text).toBeUndefined();
		expect(viaHome.tried).toEqual([join(dir, ".sitra", "profile", "white-label-names.txt")]);

		mkdirSync(join(dir, ".sitra", "profile"), { recursive: true });
		writeFileSync(join(dir, ".sitra", "profile", "white-label-names.txt"), "Zorblax\n");
		expect(findList({}, dir).text).toBe("Zorblax\n");
	});
});

const found = findList(process.env);
const names = found.text === undefined ? undefined : parseList(found.text);
const repoRoot = join(import.meta.dirname, "..");

describe("white-label check", () => {
	test.skipIf(!names)(
		names
			? "tracked files contain no forbidden names"
			: `tracked files contain no forbidden names (${skipNote(found.tried)})`,
		() => {
			const hits = scanFiles(
				repoRoot,
				trackedFiles(repoRoot).filter((f) => existsSync(join(repoRoot, f))),
				names as ForbiddenList,
			);
			expect(hits.map(describeHit)).toEqual([]);
		},
	);
});
