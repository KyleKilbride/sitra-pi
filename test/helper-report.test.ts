import { expect, test } from "vitest";
import {
	HELPER_REPORT_MARKER,
	type HelperReport,
	helperReportForLead,
	renderHelperReport,
	validateHelperReport,
} from "../extensions/helper-report.ts";

const report: HelperReport = {
	status: "blocked",
	summary: "Could not inspect the migration because the database was unavailable.",
	evidence: ["/tmp/sitra/runs/db.log", "extensions/lead.ts"],
	openQuestions: ["Should the person start the database before the builder continues?"],
	assumptions: ["No schema change was made."],
};

test("helper reports are validated fields, not accepted prose", () => {
	expect(validateHelperReport(report)).toEqual({ ok: true, report });
	expect(validateHelperReport({ ...report, status: "done-ish" })).toMatchObject({
		ok: false,
		reason: expect.stringContaining("status"),
	});
	expect(validateHelperReport("I did it")).toMatchObject({ ok: false });
});

test("the lead-facing report exposes fields and flags raw missing prose", () => {
	const rendered = renderHelperReport(report);
	expect(rendered).toContain(HELPER_REPORT_MARKER);
	const valid = helperReportForLead(rendered);
	expect(valid).toMatchObject({ ok: true, report });
	expect(valid.text).toContain("Status: blocked");
	expect(valid.text).toContain("Open questions for the person:");
	expect(valid.text).toContain("/tmp/sitra/runs/db.log");
	expect(valid.text).not.toMatch(/Kyle|Sam/);

	const missing = helperReportForLead("I read the files and it looks fine.");
	expect(missing).toMatchObject({ ok: false });
	expect(missing.text).toContain("missing structured helper_report");
	expect(missing.text).toContain("I read the files");

	const invalidJson = helperReportForLead(`${HELPER_REPORT_MARKER}\n{`);
	expect(invalidJson).toMatchObject({ ok: false });
	expect(invalidJson.text).toContain("invalid structured helper_report JSON");
});
