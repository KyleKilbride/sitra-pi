import { Type } from "typebox";

export const HELPER_REPORT_MARKER = "sitra-helper-report-v1";

export const HELPER_REPORT_SCHEMA = Type.Object({
	status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
	summary: Type.String(),
	evidence: Type.Array(Type.String()),
	openQuestions: Type.Array(Type.String()),
	assumptions: Type.Array(Type.String()),
});

export type HelperReportStatus = "done" | "blocked" | "needs-input";

export interface HelperReport {
	status: HelperReportStatus;
	summary: string;
	evidence: string[];
	openQuestions: string[];
	assumptions: string[];
}

const STATUSES = new Set<HelperReportStatus>(["done", "blocked", "needs-input"]);

const strings = (input: Record<string, unknown>, key: keyof HelperReport): string[] | string => {
	const value = input[key];
	if (!Array.isArray(value)) return `${key} must be an array`;
	const bad = value.find((item) => typeof item !== "string");
	if (bad !== undefined) return `${key} must contain only strings`;
	return value;
};

export function validateHelperReport(
	input: unknown,
): { ok: true; report: HelperReport } | { ok: false; reason: string } {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return { ok: false, reason: "report must be an object" };
	const value = input as Record<string, unknown>;
	if (!STATUSES.has(value.status as HelperReportStatus))
		return { ok: false, reason: "status must be done, blocked, or needs-input" };
	if (typeof value.summary !== "string" || value.summary.trim() === "")
		return { ok: false, reason: "summary must be a non-empty string" };
	const evidence = strings(value, "evidence");
	if (typeof evidence === "string") return { ok: false, reason: evidence };
	const openQuestions = strings(value, "openQuestions");
	if (typeof openQuestions === "string") return { ok: false, reason: openQuestions };
	const assumptions = strings(value, "assumptions");
	if (typeof assumptions === "string") return { ok: false, reason: assumptions };
	return {
		ok: true,
		report: {
			status: value.status as HelperReportStatus,
			summary: value.summary,
			evidence,
			openQuestions,
			assumptions,
		},
	};
}

export function renderHelperReport(report: HelperReport): string {
	return `${HELPER_REPORT_MARKER}\n${JSON.stringify(report, null, "\t")}`;
}

export function helperReportForLead(
	raw: string,
): { ok: true; text: string; report: HelperReport } | { ok: false; text: string } {
	const text = raw.trim();
	const prefix = `${HELPER_REPORT_MARKER}\n`;
	const markerAt = text.indexOf(prefix);
	if (markerAt < 0) {
		return {
			ok: false,
			text: `sitra: helper result is missing structured helper_report output.\n\nRaw helper output:\n${raw || "(empty)"}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(markerAt + prefix.length));
	} catch (error) {
		return {
			ok: false,
			text: `sitra: helper result has invalid structured helper_report JSON: ${String(error)}\n\nRaw helper output:\n${raw}`,
		};
	}
	const valid = validateHelperReport(parsed);
	if (!valid.ok) {
		return {
			ok: false,
			text: `sitra: helper result has invalid structured helper_report fields: ${valid.reason}\n\nRaw helper output:\n${raw}`,
		};
	}
	const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)");
	const leadText = [
		"Structured helper report (validated)",
		`Status: ${valid.report.status}`,
		`Summary: ${valid.report.summary}`,
		"Evidence:",
		list(valid.report.evidence),
		"Open questions for Kyle:",
		list(valid.report.openQuestions),
		"Assumptions:",
		list(valid.report.assumptions),
	].join("\n");
	return { ok: true, text: leadText, report: valid.report };
}
