import { type TSchema, Type } from "typebox";
import * as Value from "typebox/value";

export const HELPER_REPORT_MARKER = "sitra-helper-report-v1";

const BaseFields = {
	status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
	summary: Type.String({ minLength: 1 }),
	evidence: Type.Array(Type.String()),
	openQuestions: Type.Array(Type.String()),
	assumptions: Type.Array(Type.String()),
	dispatchId: Type.Optional(Type.String({ minLength: 1 })),
};

export const ReworkClass = Type.Union([
	Type.Literal("context-missed"),
	Type.Literal("context-missing"),
	Type.Literal("wrong-intent"),
	Type.Literal("new-information"),
	Type.Literal("execution-slip"),
	Type.Literal("check-gap"),
]);

export const Question = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		recommended: Type.String({ minLength: 1 }),
		dependsOn: Type.Array(Type.String()),
		answer: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const AcceptanceTest = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		proves: Type.String({ minLength: 1 }),
		targetFile: Type.String({ minLength: 1 }),
		command: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const roleDetail = (role: string, properties: Record<string, TSchema>) =>
	Type.Object(properties, {
		additionalProperties: false,
		description: `details when role is "${role}": only ${Object.keys(properties).join(", ")}`,
	});

export const LogDecision = Type.Object(
	{
		log: Type.String({ minLength: 1 }),
		reason: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const RerunCheck = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		log: Type.String({ minLength: 1 }),
		reason: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const RoleDetails = {
	intent: roleDetail("intent", {
		questions: Type.Array(Question),
		doneCandidates: Type.Array(Type.String()),
		ambiguities: Type.Array(Type.String()),
	}),
	codebase: roleDetail("codebase", {
		files: Type.Array(Type.String()),
		existingTests: Type.Array(Type.String()),
		facts: Type.Array(Type.String()),
		boundaries: Type.Array(Type.String()),
		owners: Type.Array(Type.String()),
	}),
	"test-design": roleDetail("test-design", {
		acceptanceTests: Type.Array(AcceptanceTest),
	}),
	architecture: roleDetail("architecture", {
		fitsExistingArchitecture: Type.Boolean(),
		boundaryConcerns: Type.Array(Type.String()),
		needlessLayersOrCode: Type.Array(Type.String()),
		simplerShape: Type.Array(Type.String()),
		checklistEntriesUsed: Type.Array(Type.String()),
		checklist: Type.Object(
			{
				state: Type.Union([Type.Literal("ok"), Type.Literal("absent"), Type.Literal("unreadable")]),
				path: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	}),
	verifier: roleDetail("verifier", {
		checksRun: Type.Array(Type.String()),
		rerunChecks: Type.Array(RerunCheck),
		acceptedLogs: Type.Array(LogDecision),
		testHashesChecked: Type.Array(Type.String()),
		goalMatched: Type.Boolean(),
		missClass: Type.Optional(ReworkClass),
	}),
} as const;

export const BASE_HELPER_REPORT_SCHEMA = Type.Object(BaseFields, { additionalProperties: false });

const roleSchema = <R extends HelperReportRole>(role: R) =>
	Type.Object(
		{
			...BaseFields,
			role: Type.Literal(role),
			details: RoleDetails[role],
		},
		{ additionalProperties: false },
	);

export const ROLE_HELPER_REPORT_SCHEMAS = {
	intent: roleSchema("intent"),
	codebase: roleSchema("codebase"),
	"test-design": roleSchema("test-design"),
	architecture: roleSchema("architecture"),
	verifier: roleSchema("verifier"),
} as const;

export const HELPER_REPORT_SCHEMA = Type.Union([
	BASE_HELPER_REPORT_SCHEMA,
	ROLE_HELPER_REPORT_SCHEMAS.intent,
	ROLE_HELPER_REPORT_SCHEMAS.codebase,
	ROLE_HELPER_REPORT_SCHEMAS["test-design"],
	ROLE_HELPER_REPORT_SCHEMAS.architecture,
	ROLE_HELPER_REPORT_SCHEMAS.verifier,
]);

export const HELPER_REPORT_TOOL_SCHEMA = Type.Object(
	{
		...BaseFields,
		role: Type.Optional(
			Type.Union(
				Object.keys(ROLE_HELPER_REPORT_SCHEMAS).map((role) => Type.Literal(role as HelperReportRole)),
				{ description: "Set this when returning one of the role-specific helper reports." },
			),
		),
		details: Type.Optional(
			Type.Union(Object.values(RoleDetails), {
				description: "Role-specific report details. Set role and fill the matching detail fields.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type HelperReportStatus = "done" | "blocked" | "needs-input";
export type HelperReportRole = "intent" | "codebase" | "test-design" | "architecture" | "verifier";

export interface HelperReport {
	status: HelperReportStatus;
	summary: string;
	evidence: string[];
	openQuestions: string[];
	assumptions: string[];
	dispatchId?: string;
	role?: HelperReportRole;
	details?: unknown;
}

function schemaFor(input: unknown): TSchema {
	if (!input || typeof input !== "object" || !("role" in input)) return BASE_HELPER_REPORT_SCHEMA;
	const role = (input as { role?: unknown }).role;
	return typeof role === "string" && role in ROLE_HELPER_REPORT_SCHEMAS
		? ROLE_HELPER_REPORT_SCHEMAS[role as HelperReportRole]
		: HELPER_REPORT_SCHEMA;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaKeys(schema: TSchema): string[] {
	return Object.keys((schema as { properties?: Record<string, TSchema> }).properties ?? {});
}

function requiredSchemaKeys(schema: TSchema): string[] {
	const required = (schema as { required?: readonly string[] }).required;
	return required ? [...required] : schemaKeys(schema);
}

function pointerSegments(instancePath: string): string[] {
	if (!instancePath.startsWith("/")) return [];
	return instancePath
		.slice(1)
		.split("/")
		.map((segment) => segment.split("~1").join("/").split("~0").join("~"));
}

function listFields(fields: string[]): string {
	return fields.length ? fields.join(", ") : "(none)";
}

function roleDetailsReason(input: unknown, role: HelperReportRole): string | undefined {
	const detailSchema = RoleDetails[role];
	const allowed = schemaKeys(detailSchema);
	const parts = [`details for role ${role} allow only: ${listFields(allowed)}`];
	if (!isRecord(input) || !Object.hasOwn(input, "details")) {
		parts.push("missing: details");
		return parts.join("; ");
	}
	const details = input.details;
	if (!isRecord(details)) {
		parts.push("details must be an object");
		return parts.join("; ");
	}
	const present = Object.keys(details);
	const required = requiredSchemaKeys(detailSchema);
	const missing = required.filter((field) => !Object.hasOwn(details, field));
	const detailErrorFields = new Set(
		[...Value.Errors(detailSchema, details)].map((error) => pointerSegments(error.instancePath)[0]).filter(Boolean),
	);
	const unexpected = present.filter((field) => !allowed.includes(field));
	const unexpectedFromErrorPaths = unexpected.filter((field) => detailErrorFields.has(field));
	if (missing.length) parts.push(`missing: ${listFields(missing)}`);
	if (unexpected.length)
		parts.push(`remove: ${listFields(unexpectedFromErrorPaths.length ? unexpectedFromErrorPaths : unexpected)}`);
	return parts.length > 1 ? parts.join("; ") : undefined;
}

function schemaErrorReason(errors: { instancePath: string; message: string }[]): string {
	const [first] = errors;
	const where = first?.instancePath ? `${first.instancePath}: ` : "";
	return `${where}${first?.message ?? "report does not match schema"}`;
}

export function validateHelperReport(
	input: unknown,
): { ok: true; report: HelperReport } | { ok: false; reason: string } {
	const schema = schemaFor(input);
	if (!Value.Check(schema, input)) {
		const errors = [...Value.Errors(schema, input)];
		if (isRecord(input) && typeof input.role === "string" && input.role in ROLE_HELPER_REPORT_SCHEMAS) {
			return {
				ok: false,
				reason: roleDetailsReason(input, input.role as HelperReportRole) ?? schemaErrorReason(errors),
			};
		}
		return { ok: false, reason: schemaErrorReason(errors) };
	}
	const value = input as HelperReport;
	const report: HelperReport = {
		status: value.status,
		summary: value.summary,
		evidence: value.evidence,
		openQuestions: value.openQuestions,
		assumptions: value.assumptions,
	};
	if (value.dispatchId) report.dispatchId = value.dispatchId;
	if (value.role) report.role = value.role;
	if (value.details !== undefined) report.details = value.details;
	return { ok: true, report };
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
		...(valid.report.role ? [`Role: ${valid.report.role}`] : []),
		"Evidence:",
		list(valid.report.evidence),
		"Open questions for the person:",
		list(valid.report.openQuestions),
		"Assumptions:",
		list(valid.report.assumptions),
		...(valid.report.details !== undefined ? ["Details:", JSON.stringify(valid.report.details, null, "\t")] : []),
	].join("\n");
	return { ok: true, text: leadText, report: valid.report };
}
