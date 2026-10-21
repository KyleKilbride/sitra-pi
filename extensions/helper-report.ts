import { Type } from "typebox";
import * as Value from "typebox/value";

export const HELPER_REPORT_MARKER = "sitra-helper-report-v1";

export const HELPER_REPORT_SCHEMA = Type.Object({
	status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
	summary: Type.String({ minLength: 1 }),
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

export function validateHelperReport(
	input: unknown,
): { ok: true; report: HelperReport } | { ok: false; reason: string } {
	if (!Value.Check(HELPER_REPORT_SCHEMA, input)) {
		const [first] = Value.Errors(HELPER_REPORT_SCHEMA, input);
		const where = first?.instancePath ? `${first.instancePath}: ` : "";
		return { ok: false, reason: `${where}${first?.message ?? "report does not match schema"}` };
	}
	const value = input as HelperReport;
	return {
		ok: true,
		report: {
			status: value.status,
			summary: value.summary,
			evidence: value.evidence,
			openQuestions: value.openQuestions,
			assumptions: value.assumptions,
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
		"Open questions for the person:",
		list(valid.report.openQuestions),
		"Assumptions:",
		list(valid.report.assumptions),
	].join("\n");
	return { ok: true, text: leadText, report: valid.report };
}
