import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const pythonAvailable = spawnSync("python3", ["--version"]).status === 0;

test.skipIf(!pythonAvailable || process.platform === "win32")(
	"real PTY handles raw keys, mailbox open/back, run output, refresh, resizing, focus and cleanup",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "radar-pty-"));
		try {
			mkdirSync(join(dir, "sitra-sessions"));
			mkdirSync(join(dir, "runs"));
			mkdirSync(join(dir, "bin"));
			writeFileSync(
				join(dir, "sitra-sessions", "lead.json"),
				JSON.stringify({
					id: "worker",
					role: "lead",
					pid: process.pid,
					cwd: dir,
					repo: dir,
					paneId: "w2:p3",
					status: "idle",
					task: "worker-marker",
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
			);
			const config = join(dir, "sitra-mail.json");
			writeFileSync(
				config,
				JSON.stringify({
					items: [
						{
							id: "message",
							peer: "peer-marker",
							direction: "in",
							state: "received",
							summary: "subject-marker",
							body: `body-marker\n${Array.from({ length: 60 }, (_, i) => `scroll-line-${i}`).join("\n")}`,
							updatedAt: new Date().toISOString(),
						},
					],
				}),
			);
			writeFileSync(join(dir, "runs", "2026-10-21-test.log"), "log-marker\n__SITRA_RUN_DONE__ 0\n");
			const calls = join(dir, "calls.log");
			writeFileSync(join(dir, "bin", "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho '{"result":{}}'\n`);
			chmodSync(join(dir, "bin", "herdr"), 0o755);
			const source = fileURLToPath(new URL("../extensions/radar-runtime.ts", import.meta.url));
			const program = `import { runRadarTui } from ${JSON.stringify(source)}; runRadarTui(${JSON.stringify(dir)});`;
			const script = String.raw`
import os, pty, sys, select, time, fcntl, termios, struct, signal, json
pid, fd = pty.fork()
if pid == 0:
 os.execv(sys.argv[1], [sys.argv[1], '--input-type=module', '--eval', sys.argv[2]])

def receive():
 chunks = []
 deadline = time.monotonic() + 0.4
 while time.monotonic() < deadline:
  ready, _, _ = select.select([fd], [], [], max(0, deadline-time.monotonic()))
  if not ready: break
  try: chunks.append(os.read(fd, 65536))
  except OSError: break
 return b''.join(chunks)

def send(data):
 os.write(fd, data)
 return receive()

def alive():
 result, status = os.waitpid(pid, os.WNOHANG)
 assert result == 0, ('radar exited early', status)

try:
 fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 84, 0, 0))
 start = receive() + receive()
 assert b'\x1b[?1049h' in start, 'alternate screen missing'
 assert b'worker-marker' in start, 'workspace not rendered'
 mail = send(b'm')
 assert b'subject-marker' in mail, 'mailbox did not open'
 detail = send(b'\r')
 assert b'body-marker' in detail, 'message did not open'
 assert b'scroll-line-' in send(b'\x1b[4~'), 'End did not reach long-message tail'
 assert b'scroll-line-' in send(b'\x1b[A'), 'Up could not move away from End'
 send(b'\x1b[6~'); send(b'\x1b[5~'); send(b'\x1b')
 send(b'r'); receive()
 alive()
 send(b'q'); alive()
 runs = send(b'b')
 log = send(b'\r')
 assert b'log-marker' in log, 'run did not open'
 send(b'\x1b'); send(b'\x1b')
 send(b'\x1b[115u'); send(b'\x1b')
 send(b'\x1b[66;1u'); send(b'\x1b')
 # Kitty mailbox, enter and escape; key release must not quit.
 send(b'\x1b[109u'); send(b'\x1b[13u'); send(b'\x1b[113;1:3u'); alive()
 send(b'\x1b[27u'); send(b'q'); alive()
 send(b'\x1b[B'); send(b'\x1b[A'); send(b'\r'); send(b'1')
 # Refresh observes changed local mail without restarting the process.
 with open(sys.argv[3]) as f: snapshot = json.load(f)
 snapshot['items'][0]['body'] = 'live-update-marker'
 with open(sys.argv[3], 'w') as f: json.dump(snapshot, f)
 send(b'r'); send(b'm')
 assert b'live-update-marker' in send(b'\r'), 'mail refresh did not update'
 fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 36, 0, 0))
 os.kill(pid, signal.SIGWINCH)
 receive()
 alive()
 send(b'\x1b'); send(b'q')
 ending = send(b'q')
 assert b'\x1b[?1049l' in ending and b'\x1b[?25h' in ending, 'terminal not restored'
 _, status = os.waitpid(pid, 0)
 assert os.waitstatus_to_exitcode(status) == 0
 os.close(fd)
 # A second real dashboard quits while a local provider is still running.
 base = os.path.dirname(sys.argv[3])
 started = os.path.join(base, 'provider-started')
 stopped = os.path.join(base, 'provider-stopped')
 adapter = os.path.join(base, 'slow-provider.mjs')
 with open(adapter, 'w') as f:
  f.write('import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{writeFileSync('+json.dumps(stopped)+',"stopped");process.exit(0)});writeFileSync('+json.dumps(started)+',"started");setInterval(()=>{},1000);')
 with open(os.path.join(base, 'radar-mail-source.json'), 'w') as f:
  json.dump({'command':sys.argv[1], 'args':[adapter]}, f)
 pid, fd = pty.fork()
 if pid == 0:
  os.execv(sys.argv[1], [sys.argv[1], '--input-type=module', '--eval', sys.argv[2]])
 fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 84, 0, 0))
 receive(); receive()
 assert os.path.exists(started), 'provider never started'
 ending = send(b'\x03')
 assert b'\x1b[?1049l' in ending, 'Ctrl-C did not restore terminal'
 _, status = os.waitpid(pid, 0)
 assert os.waitstatus_to_exitcode(status) == 0
 deadline = time.monotonic() + 1
 while not os.path.exists(stopped) and time.monotonic() < deadline:
  select.select([], [], [], 0.01)
 assert os.path.exists(stopped), 'provider was not cancelled when dashboard quit'
 print('PTY checks passed')
except BaseException:
 try: os.kill(pid, signal.SIGKILL)
 except ProcessLookupError: pass
 raise
finally:
 os.close(fd)
`;
			const output = execFileSync("python3", ["-c", script, process.execPath, program, config], {
				encoding: "utf8",
				timeout: 20_000,
				env: { ...process.env, HERDR_ENV: "0", PATH: `${join(dir, "bin")}:${process.env.PATH}` },
			});
			expect(output).toContain("PTY checks passed");
			expect(
				readFileSync(calls, "utf8")
					.split("\n")
					.filter((line) => line === "workspace focus w2").length,
			).toBeGreaterThanOrEqual(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	25_000,
);
