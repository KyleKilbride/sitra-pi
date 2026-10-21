import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailItem } from "./radar.ts";
import { type TowerSummary, terminalText, validSummary } from "./radar-model.ts";

/** Read the tower's explicit summary; an idle worker is never evidence that its task is done. */
export function readTowerSummary(profileDir: string): TowerSummary | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(profileDir, "radar-status.json"), "utf8"));
		return validSummary(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Publish one complete status update atomically, so the dashboard never sees half a write. */
export function writeTowerSummary(profileDir: string, summary: TowerSummary): void {
	if (!validSummary(summary)) throw new Error("Invalid dashboard summary");
	mkdirSync(profileDir, { recursive: true });
	const file = join(profileDir, `radar-status-${randomUUID()}.tmp`);
	try {
		writeFileSync(file, JSON.stringify(summary), { mode: 0o600, flag: "wx" });
		renameSync(file, join(profileDir, "radar-status.json"));
	} finally {
		if (existsSync(file)) unlinkSync(file);
	}
}

export interface MailSnapshot {
	items: MailItem[];
	notice?: string;
	updatedAt?: string;
}

/** Strictly project display fields from a local adapter; never treat remote content as terminal instructions. */
export function parseMailSnapshot(value: unknown): MailSnapshot {
	if (!value || typeof value !== "object" || !Array.isArray((value as MailSnapshot).items))
		throw new Error("Invalid mailbox snapshot");
	const source = value as MailSnapshot;
	if (source.items.length > 500) throw new Error("Mailbox snapshot too large");
	const seen = new Set<string>();
	const items = source.items.map((item) => {
		if (
			!item ||
			typeof item !== "object" ||
			![item.id, item.peer, item.state, item.summary, item.updatedAt].every((v) => typeof v === "string") ||
			!["in", "out"].includes(item.direction) ||
			!Number.isFinite(Date.parse(item.updatedAt)) ||
			(item.body !== undefined && typeof item.body !== "string") ||
			(item.dateApproximate !== undefined && typeof item.dateApproximate !== "boolean") ||
			seen.has(item.id) ||
			item.id.length > 500
		)
			throw new Error("Invalid mailbox item");
		seen.add(item.id);
		return {
			id: item.id,
			peer: terminalText(item.peer).slice(0, 200),
			state: terminalText(item.state).slice(0, 100),
			summary: terminalText(item.summary).slice(0, 1000),
			direction: item.direction,
			updatedAt: new Date(item.updatedAt).toISOString(),
			...(item.dateApproximate ? { dateApproximate: true } : {}),
			...(item.body !== undefined ? { body: terminalText(item.body).slice(0, 256_000) } : {}),
		};
	});
	return {
		items: items.sort(
			(a, b) =>
				Number(a.dateApproximate === true) - Number(b.dateApproximate === true) ||
				b.updatedAt.localeCompare(a.updatedAt),
		),
		...(typeof source.notice === "string" ? { notice: terminalText(source.notice).slice(0, 1000) } : {}),
		...(typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt))
			? { updatedAt: new Date(source.updatedAt).toISOString() }
			: {}),
	};
}

/** Local file fallback for integrations that publish their own read-only snapshot. */
export function collectMail(profileDir: string): MailItem[] {
	try {
		return parseMailSnapshot(JSON.parse(readFileSync(join(profileDir, "sitra-mail.json"), "utf8"))).items;
	} catch {
		return [];
	}
}

/** Run an explicitly configured local read-only provider without a shell or a second network mailbox consumer. */
export function loadMailbox(profileDir: string, signal?: AbortSignal): Promise<MailSnapshot> {
	if (signal?.aborted) return Promise.reject(new DOMException("Mailbox refresh cancelled", "AbortError"));
	const configFile = join(profileDir, "radar-mail-source.json");
	if (!existsSync(configFile)) {
		try {
			return Promise.resolve(parseMailSnapshot(JSON.parse(readFileSync(join(profileDir, "sitra-mail.json"), "utf8"))));
		} catch {
			return Promise.resolve({ items: [], notice: "No live mailbox connected. Configure a local mailbox source." });
		}
	}
	return new Promise((resolve, reject) => {
		try {
			const config: unknown = JSON.parse(readFileSync(configFile, "utf8"));
			const c = config as { command?: unknown; args?: unknown };
			if (
				!c ||
				typeof c.command !== "string" ||
				!Array.isArray(c.args) ||
				!c.args.every((arg) => typeof arg === "string")
			)
				throw new Error("Invalid mailbox source configuration");
			execFile(
				c.command,
				c.args as string[],
				{ timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", signal },
				(error, stdout) => {
					if (signal?.aborted) {
						reject(new DOMException("Mailbox refresh cancelled", "AbortError"));
						return;
					}
					if (error) {
						reject(new Error("Mailbox source failed; last good messages retained"));
						return;
					}
					try {
						resolve(parseMailSnapshot(JSON.parse(stdout)));
					} catch {
						reject(new Error("Mailbox source returned invalid data; last good messages retained"));
					}
				},
			);
		} catch {
			reject(new Error("Mailbox source configuration is invalid"));
		}
	});
}
