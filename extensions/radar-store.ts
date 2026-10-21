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
		if (!item || typeof item !== "object") throw new Error("Invalid mailbox item");
		const raw = item as MailItem & {
			subject?: unknown;
			preview?: unknown;
			summary?: unknown;
			delivery?: unknown;
		};
		const delivery = raw.delivery as { confirmed?: unknown; status?: unknown } | undefined;
		const deliveryValid =
			raw.delivery === undefined ||
			(raw.delivery !== null &&
				typeof raw.delivery === "object" &&
				(delivery?.confirmed === undefined || typeof delivery.confirmed === "boolean") &&
				(delivery?.status === undefined || typeof delivery.status === "string"));
		const subjectSource =
			typeof raw.subject === "string" ? raw.subject : typeof raw.summary === "string" ? raw.summary : "";
		const subject = terminalText(subjectSource).replace(/\s+/g, " ").trim().slice(0, 300);
		const body = typeof raw.body === "string" ? terminalText(raw.body).slice(0, 256_000) : undefined;
		const explicitPreview =
			typeof raw.preview === "string" ? terminalText(raw.preview).replace(/\s+/g, " ").trim().slice(0, 500) : undefined;
		const preview =
			explicitPreview ??
			body
				?.split("\n")
				.map((line) => line.trim())
				.find(Boolean)
				?.slice(0, 500);
		if (
			![item.id, item.peer, item.state, item.updatedAt].every((v) => typeof v === "string") ||
			!subject ||
			!["in", "out"].includes(item.direction) ||
			!Number.isFinite(Date.parse(item.updatedAt)) ||
			(item.body !== undefined && typeof item.body !== "string") ||
			(raw.preview !== undefined && typeof raw.preview !== "string") ||
			(item.dateApproximate !== undefined && typeof item.dateApproximate !== "boolean") ||
			!deliveryValid ||
			seen.has(item.id) ||
			item.id.length > 500
		)
			throw new Error("Invalid mailbox item");
		seen.add(item.id);
		return {
			id: item.id,
			peer: terminalText(item.peer).slice(0, 200),
			state: terminalText(item.state).slice(0, 100),
			summary: subject,
			subject,
			...(preview ? { preview } : {}),
			direction: item.direction,
			updatedAt: new Date(item.updatedAt).toISOString(),
			...(deliveryValid && raw.delivery !== undefined
				? {
						delivery: {
							...(typeof delivery?.confirmed === "boolean" ? { confirmed: delivery.confirmed } : {}),
							...(typeof delivery?.status === "string" ? { status: terminalText(delivery.status).slice(0, 100) } : {}),
						},
					}
				: {}),
			...(item.dateApproximate ? { dateApproximate: true } : {}),
			...(body !== undefined ? { body } : {}),
		};
	});
	return {
		items: items.sort(
			(a, b) =>
				Number(a.direction === "out") - Number(b.direction === "out") ||
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
