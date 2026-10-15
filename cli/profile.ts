/** Copies the profile templates into a Pi profile, filling in {{name}} and never overwriting the person's own edits. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Scaffold {
	created: string[];
	kept: string[];
}

export function fillTemplate(text: string, vars: { name: string }): string {
	return text.replaceAll("{{name}}", vars.name);
}

export function scaffoldProfile(templates: string, profile: string, vars: { name: string }): Scaffold {
	const result: Scaffold = { created: [], kept: [] };
	const files = readdirSync(templates, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name).slice(templates.length + 1))
		.sort();
	for (const file of files) {
		const target = join(profile, file);
		if (existsSync(target)) {
			result.kept.push(file);
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, fillTemplate(readFileSync(join(templates, file), "utf8"), vars));
		result.created.push(file);
	}
	return result;
}
