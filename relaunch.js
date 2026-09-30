/**
 * Detached relauncher for `dsh-web-restart`.
 *
 * The Host half spawns this file with `detached: true` and stdout/stderr
 * pointing at the daemon log, then shuts itself down. This process therefore
 * outlives it: it waits for the old PID to disappear, starts the replacement in
 * its own session with no controlling terminal, and exits.
 *
 * Inherited stdin is `/dev/null` and inherited stdout/stderr are the log file,
 * so the replacement runs as a daemon and every startup line — including the
 * `dsh web: <url>` line the Web app prints — lands in the log instead of a
 * terminal.
 *
 * Usage: `node relaunch.js '<json spec>'`, where the spec carries the old pid,
 * the exact command, the working directory, the log path, and the wait budget.
 *
 * @module dsh-web-restart/relaunch
 */

import { spawn } from 'node:child_process'

/** Wait step between liveness probes. */
const POLL_MS = 150
/** Grace for the child's `spawn` event before this process reports and exits anyway. */
const SPAWN_EVENT_MS = 5_000

/**
 * Parse the spec argument this process was started with.
 * @returns the launch spec.
 * @throws when the argument is missing or malformed.
 */
function readSpec() {
	const raw = process.argv[2]
	if (typeof raw !== 'string' || raw === '') throw new Error('missing launch spec argument')
	const spec = JSON.parse(raw)
	if (typeof spec.pid !== 'number' || typeof spec.command !== 'string' || !Array.isArray(spec.args)) {
		throw new Error('malformed launch spec argument')
	}
	return spec
}

/** Append one timestamped line to the inherited log stream. */
function note(message) {
	process.stdout.write(`${new Date().toISOString()} [web-restart/relaunch] ${message}\n`)
}

/**
 * Whether a process id is still present.
 * @param pid - the process id to probe.
 * @returns true when the process exists (EPERM also means it exists).
 */
function alive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === 'EPERM'
	}
}

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Start the replacement and resolve once the operating system accepted it.
 * @param spec - the launch spec.
 * @returns the spawned child.
 */
async function startDaemon(spec) {
	const child = spawn(spec.command, spec.args, {
		cwd: typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : undefined,
		env: process.env,
		detached: true,
		stdio: ['ignore', 1, 2],
	})
	await new Promise((resolve) => {
		const settle = () => {
			clearTimeout(timer)
			child.off('spawn', settle)
			child.off('error', onError)
			resolve()
		}
		const onError = (error) => {
			note(`could not start the replacement: ${error.message}`)
			process.exitCode = 1
			settle()
		}
		const timer = setTimeout(() => {
			note('the replacement did not report a spawn event in time; leaving it to run')
			settle()
		}, SPAWN_EVENT_MS)
		child.once('spawn', settle)
		child.once('error', onError)
	})
	child.unref()
	return child
}

const spec = readSpec()
const budgetMs = typeof spec.waitMs === 'number' && spec.waitMs > 0 ? spec.waitMs : 30_000
const deadline = Date.now() + budgetMs

while (alive(spec.pid) && Date.now() < deadline) await sleep(POLL_MS)

if (alive(spec.pid)) note(`pid ${String(spec.pid)} is still alive after ${String(budgetMs)}ms; starting the replacement anyway`)
else note(`pid ${String(spec.pid)} exited; starting ${String(spec.display ?? spec.command)}`)

const child = await startDaemon(spec)
if (child.pid !== undefined) note(`daemon pid=${String(child.pid)} log=${String(spec.logFile ?? '(inherited)')}`)
