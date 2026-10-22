import * as Value from "typebox/value";
import { expect, test } from "vitest";
import {
	HELPER_REPORT_MARKER,
	HELPER_REPORT_TOOL_SCHEMA,
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

const roleDetailsFixtures = {
	intent: {
		questions: [{ id: "q1", text: "Use the existing CLI shape?", recommended: "Yes, keep it.", dependsOn: [] }],
		doneCandidates: ["The CLI keeps existing behavior."],
		ambiguities: [],
	},
	codebase: {
		files: ["cli/init.ts:1"],
		existingTests: ["test/init.test.ts:1"],
		facts: ["Verified: init scaffolds recursively."],
		boundaries: ["Observed: Pi wiring stays out of cli/."],
		owners: ["Verified: git log -S scaffoldProfile names the relevant maintainer."],
	},
	"test-design": {
		acceptanceTests: [
			{
				name: "private profile wins",
				proves: "existing files are not overwritten",
				targetFile: "test/init.test.ts",
				command: "pnpm vitest run test/init.test.ts",
			},
		],
	},
	architecture: {
		fitsExistingArchitecture: true,
		boundaryConcerns: [],
		needlessLayersOrCode: [],
		simplerShape: ["Keep validation in helper-report.ts."],
		checklistEntriesUsed: ["read-only helpers"],
		checklist: { state: "ok", path: "$PI_CODING_AGENT_DIR/agents/checklists/architecture.md" },
	},
	verifier: {
		checksRun: ["pnpm vitest run test/helper-report.test.ts"],
		rerunChecks: [{ command: "pnpm vitest run test/helper-report.test.ts", log: "/tmp/run.log", reason: "cheap" }],
		acceptedLogs: [{ log: "/tmp/red.log", reason: "tied to commit and test hashes" }],
		testHashesChecked: ["test/helper-report.test.ts sha256:abc"],
		goalMatched: true,
	},
} as const;

test("helper reports are validated fields, not accepted prose", () => {
	expect(validateHelperReport(report)).toEqual({ ok: true, report });
	expect(validateHelperReport({ ...report, status: "done-ish" })).toMatchObject({
		ok: false,
		reason: expect.stringContaining("status"),
	});
	expect(validateHelperReport("I did it")).toMatchObject({ ok: false });
});

test("role reports validate their role-specific details", () => {
	for (const [role, roleDetails] of Object.entries(roleDetailsFixtures)) {
		expect(validateHelperReport({ ...report, status: "done", role, details: roleDetails })).toMatchObject({
			ok: true,
			report: { role, details: roleDetails },
		});
	}
});

test("declared tool schema accepts every valid strict role report fixture", () => {
	for (const [role, details] of Object.entries(roleDetailsFixtures)) {
		const candidate = { ...report, status: "done", role, details };
		expect(validateHelperReport(candidate)).toMatchObject({ ok: true });
		expect(Value.Check(HELPER_REPORT_TOOL_SCHEMA, candidate)).toBe(true);
	}
});

test("mismatched role details are rejected with the field path", () => {
	expect(
		validateHelperReport({
			...report,
			role: "verifier",
			details: { checksRun: [], rerunChecks: [], acceptedLogs: [], testHashesChecked: [], goalMatched: "yes" },
		}),
	).toMatchObject({ ok: false, reason: expect.stringContaining("/details/goalMatched") });
});

test("a report without a role still validates as the plain base report", () => {
	expect(validateHelperReport({ ...report })).toEqual({ ok: true, report });
});

test("intent questions carry recommended answers and dependencies", () => {
	const q = { id: "q2", text: "Keep the pure helper?", recommended: "Yes, keep it pure.", dependsOn: ["q1"] };
	expect(
		validateHelperReport({
			...report,
			role: "intent",
			details: { questions: [q], doneCandidates: [], ambiguities: [] },
		}),
	).toMatchObject({ ok: true, report: { details: { questions: [q] } } });
});

test("architecture reports carry checklist state and path", () => {
	for (const state of ["ok", "absent", "unreadable"]) {
		expect(
			validateHelperReport({
				...report,
				role: "architecture",
				details: {
					fitsExistingArchitecture: true,
					boundaryConcerns: [],
					needlessLayersOrCode: [],
					simplerShape: [],
					checklistEntriesUsed: [],
					checklist: { state, path: "$PI_CODING_AGENT_DIR/agents/checklists/architecture.md" },
				},
			}),
		).toMatchObject({ ok: true });
	}
	expect(
		validateHelperReport({
			...report,
			role: "architecture",
			details: {
				fitsExistingArchitecture: true,
				boundaryConcerns: [],
				needlessLayersOrCode: [],
				simplerShape: [],
				checklistEntriesUsed: [],
				checklist: { state: "missing", path: "x" },
			},
		}),
	).toMatchObject({ ok: false, reason: expect.stringContaining("/details/checklist/state") });
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
