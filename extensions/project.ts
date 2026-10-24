/**
 * Projects: which Grimoire project a folder belongs to. The registry lives in `<grimoire>/projects.json`; a checkout
 * belongs to the project one of its git remotes is attached to, or, only when listed explicitly, to a project whose
 * `paths` names it. No Pi imports; the only process call is `git`.
 */

export interface Project {
	id: string;
	label: string;
	remotes: string[];
	paths: string[];
}

export interface ProjectRegistry {
	projects: Project[];
}

export interface Remote {
	name: string;
	key: string;
}

export type ProjectMatch =
	| { state: "matched"; project: Project; via: string; checkout: string; remotes: Remote[]; warnings: string[] }
	| { state: "none"; checkout: string; remotes: Remote[]; reason: "no-git" | "no-remote" | "unattached" }
	| { state: "ambiguous"; checkout: string; remotes: Remote[]; candidates: { remote: Remote; project: Project }[] };

export const PROJECTS_FILE = "projects.json";

export function normalizeRemote(_url: string, _base?: string): string {
	throw new Error("not implemented");
}

export function checkoutRemotes(_checkout: string): Remote[] {
	throw new Error("not implemented");
}

export function validateProjects(_registry: unknown): string[] {
	throw new Error("not implemented");
}

export function readProjects(_dir: string): ProjectRegistry {
	throw new Error("not implemented");
}

export function writeProjects(_dir: string, _registry: ProjectRegistry): void {
	throw new Error("not implemented");
}

export function projectFor(_cwd: string, _registry: ProjectRegistry): ProjectMatch {
	throw new Error("not implemented");
}
