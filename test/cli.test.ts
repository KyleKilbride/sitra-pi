import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { profileDir, readConfig, sitraHome, writeConfig } from "../cli/config.ts";
import { piArgs, piEnv } from "../cli/launch.ts";
import { scaffoldProfile } from "../cli/profile.ts";
import { atLeast, parseVersion } from "../cli/versions.ts";
import { leadRules } from "../extensions/lead.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-cli-")));

describe("versions", () => {
	test("reads the version out of each tool's --version output", () => {
		expect(parseVersion("herdr 0.9.1\n")).toBe("0.9.1");
		expect(parseVersion("1.0.0\n")).toBe("1.0.0");
		expect(parseVersion("v24.12.0")).toBe("24.12.0");
		expect(parseVersion("command not found")).toBeUndefined();
	});

	test("compares each part as a number", () => {
		expect(atLeast("1.1.0", "1.0.0")).toBe(true);
		expect(atLeast("1.0.0", "1.0.0")).toBe(true);
		expect(atLeast("0.9.0", "0.9.1")).toBe(false);
		expect(atLeast("0.10.0", "0.9.1")).toBe(true);
	});
});

describe("config", () => {
	test("lives in ~/.sitra unless SITRA_HOME says otherwise", () => {
		expect(sitraHome({}, "/home/sam")).toBe("/home/sam/.sitra");
		expect(sitraHome({ SITRA_HOME: "/elsewhere" }, "/home/sam")).toBe("/elsewhere");
		expect(profileDir("/home/sam/.sitra")).toBe("/home/sam/.sitra/profile");
	});

	test("reads back what was written, and starts empty", () => {
		const dir = tmp();
		expect(readConfig(dir)).toEqual({ name: "", skills: [] });
		writeConfig(dir, { name: "Sam", skills: ["/skills/a"] });
		expect(readConfig(dir)).toEqual({ name: "Sam", skills: ["/skills/a"] });
	});
});

describe("launch", () => {
	test("passes Pi's arguments through when no skills are listed", () => {
		expect(piArgs({ name: "Sam", skills: [] }, ["-c"])).toEqual(["-c"]);
	});

	test("loads only the listed skills when there are some", () => {
		expect(piArgs({ name: "Sam", skills: ["/a", "/b"] }, ["-c"])).toEqual([
			"--no-skills",
			"--skill",
			"/a",
			"--skill",
			"/b",
			"-c",
		]);
	});

	test("points Pi at the sitra profile and tells the lead who it works with", () => {
		const env = piEnv("/home/sam/.sitra", { name: "Sam", skills: [] }, { PATH: "/bin" });
		expect(env).toEqual({
			PATH: "/bin",
			PI_CODING_AGENT_DIR: "/home/sam/.sitra/profile",
			PI_MEMORY_DIR: "/home/sam/.sitra/profile/memory",
			SITRA_USER_NAME: "Sam",
		});
	});
});

describe("profile", () => {
	const templates = () => {
		const dir = tmp();
		mkdirSync(join(dir, "agents"));
		writeFileSync(join(dir, "AGENTS.md"), "# Working with {{name}}\n{{name}} merges.\n");
		writeFileSync(join(dir, "agents", "builder.md"), "Never merge; {{name}} merges.\n");
		return dir;
	};

	test("copies every template with the name filled in", () => {
		const profile = join(tmp(), "profile");
		const result = scaffoldProfile(templates(), profile, { name: "Sam" });
		expect(result).toEqual({ created: ["AGENTS.md", "agents/builder.md"], kept: [] });
		expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("# Working with Sam\nSam merges.\n");
		expect(readFileSync(join(profile, "agents", "builder.md"), "utf8")).toBe("Never merge; Sam merges.\n");
	});

	test("never overwrites a file the person already has", () => {
		const t = templates();
		const profile = join(tmp(), "profile");
		scaffoldProfile(t, profile, { name: "Sam" });
		writeFileSync(join(profile, "AGENTS.md"), "my own rules\n");
		const again = scaffoldProfile(t, profile, { name: "Sam" });
		expect(again).toEqual({ created: [], kept: ["AGENTS.md", "agents/builder.md"] });
		expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("my own rules\n");
	});
});

describe("lead rules", () => {
	test("are written for the person by name", () => {
		const rules = leadRules("Sam");
		expect(rules).toContain("the agent Sam talks to");
		expect(rules).toContain("Sam's words are the spec");
		expect(rules).not.toContain("Kyle");
	});

	test('fall back to "the user" without a name', () => {
		const rules = leadRules(undefined);
		expect(rules).toContain("the agent the user talks to");
		expect(rules).toContain("The user's words are the spec");
	});
});
