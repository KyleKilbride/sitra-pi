#!/usr/bin/env node
/** sitra: `sitra init` sets up; `sitra tower` (or `sitra <name>`) starts your number 2; `sitra` starts a worker lead. */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { profileDir, readConfig, sitraHome } from "../cli/config.ts";
import { type ExecResult, runInit } from "../cli/init.ts";
import { ensureTowerName, isRadarCommand, isTowerCommand, launchCommand, piEnv } from "../cli/launch.ts";
import { runRadarTui } from "../extensions/radar.ts";

const repoRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const [first, ...rest] = process.argv.slice(2);
const sitra = sitraHome(process.env, homedir());

if (first === "init") {
	const yes = rest.includes("--yes");
	const interactive = stdin.isTTY && !yes;
	const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
	const result = await runInit({
		home: homedir(),
		env: process.env,
		repoRoot,
		nodeVersion: process.versions.node,
		exec(command, args, options): ExecResult {
			const run = spawnSync(command, args, {
				env: options?.env ?? process.env,
				encoding: "utf8",
				stdio: options?.show ? "inherit" : ["ignore", "pipe", "pipe"],
			});
			if (run.error) return { code: 127, stdout: "" };
			// A failure's message is often on stderr; keep it so init can show what went wrong.
			const output = run.status === 0 ? (run.stdout ?? "") : `${run.stdout ?? ""}${run.stderr ?? ""}`;
			return { code: run.status ?? 1, stdout: output };
		},
		async ask(question, fallback) {
			if (!rl) return fallback;
			const answer = await rl.question(`${question}${fallback ? ` (${fallback})` : ""} `);
			return answer.trim() || fallback;
		},
		async confirm(question) {
			if (!rl) return yes;
			const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
			return answer === "" || answer.startsWith("y");
		},
		log: (line) => console.log(line),
	});
	rl?.close();
	console.log(result.needsYou.length > 1 ? "\nStill to do:" : "\nNext:");
	for (const item of result.needsYou) console.log(`- ${item}`);
} else {
	if (!existsSync(profileDir(sitra))) {
		console.error("sitra isn't set up yet. Run: sitra init");
		process.exit(1);
	}
	let config = readConfig(sitra);
	if (isRadarCommand(first, rest, config)) {
		runRadarTui(profileDir(sitra), { towerName: config.tower, closePaneOnExit: rest.includes("--tui") });
	} else {
		if (!process.env.HERDR_ENV) {
			console.error(
				"Not inside herdr: teammates and long runs won't get their own panes. Start herdr first for the full setup.",
			);
		}
		const tower = isTowerCommand(first, config);
		if (tower && !config.tower?.trim()) {
			const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
			config = await ensureTowerName(sitra, config, async (q) => (rl ? await rl.question(`${q} `) : ""));
			rl?.close();
			console.log(
				`${config.tower} is on watch. Next time, either \`sitra tower\` or \`sitra ${config.tower?.toLowerCase()}\` starts it.`,
			);
		}
		const args = tower || first === undefined ? rest : [first, ...rest];
		const role = tower ? "tower" : "lead";
		const plan = launchCommand(config, args, role);
		const run = spawnSync(plan.command, plan.args, {
			stdio: "inherit",
			env: piEnv(sitra, config, process.env, role),
		});
		process.exit(run.status ?? 1);
	}
}
