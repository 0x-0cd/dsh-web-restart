/**
 * `dsh-web-restart` — Host half: two routes on the composition's `webServer`
 * that let the Web GUI restart this process and keep it running as a detached
 * background daemon.
 *
 * Why this exists: after installing or updating a plugin — or editing
 * `$DSH_HOME/.env` — the running `dsh web` process still holds the previous
 * module generation and the previous environment snapshot, so the change only
 * takes effect after a process restart. Normally that means going back to the
 * terminal that launched the GUI, pressing Ctrl-C, and running `dsh web` again.
 * This plugin moves that restart into the page:
 *
 * - `GET  /web-restart/status`  — what this process is and what a restart would run.
 * - `POST /web-restart/restart` — start the detached relauncher, answer the page,
 *   then shut this process down through the launcher's own graceful path.
 *
 * `relaunch.js` waits for this process to exit and then starts the replacement
 * in its own session, with stdin on `/dev/null` and stdout/stderr appended to a
 * log file, so the new process survives the terminal (and survives that
 * terminal closing) and never reopens a browser tab.
 *
 * Two details make the new process interchangeable with the old one:
 *
 * - The command line is the original one (`process.argv`), replayed verbatim
 *   except for the flags this plugin owns, so every launcher flag — `--profile`,
 *   `--patch`, `--trusted-host` — is kept.
 * - `--no-open --port <the port this process is listening on>` is appended last,
 *   because the browser's authentication cookie is bound to the request
 *   authority (`host:port`); a different port would strand the page on a 401.
 *   Appending also wins over an original `--port 0`, which resolves to a fresh
 *   port on every start.
 *
 * The override block is idempotent. The argv of the process being replaced is
 * itself the output of the previous restart, so it already carries that block;
 * `replayArgs` removes any copy of the owned flags before the fresh block is
 * appended. Without it a chain of restarts would accumulate one more
 * `--no-open --port 3080` per restart.
 *
 * Security has one home, here: every route asks the composition's `connection`
 * service for a rejection first (`requestRejection`), so the Host/Origin fence
 * and the browser-session cookie gate every caller — the same fence
 * `@deepseek-ai/dsh-host-open-in-app` puts in front of its routes.
 *
 * @module dsh-web-restart
 */

import { spawn } from 'node:child_process'
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-restart'

/** The route carrier and the trust fence guarding every route. */
export const inject = ['webServer', 'connection']

/** GET route: this process, the restart plan, and the daemon log path. */
const STATUS_PATH = '/web-restart/status'
/** POST route: perform the restart. */
const RESTART_PATH = '/web-restart/restart'
/** The detached helper that outlives this process and starts its replacement. */
const RELAUNCH_SCRIPT = fileURLToPath(new URL('./relaunch.js', import.meta.url))
/** Default daemon log inside the harness home. */
const LOG_DIR = 'logs'
const LOG_NAME = 'web-daemon.log'
/** How long the relauncher waits for this process to exit before starting anyway. */
const WAIT_FOR_EXIT_MS = 30_000
/** Time for the HTTP answer to reach the browser before this process shuts down. */
const RESPONSE_GRACE_MS = 400
/** Diagnostic prefix in every line this plugin appends to the log. */
const TAG = 'web-restart'

/** JSON response (no-store: process facts and restart outcomes are live facts). */
function sendJson(res, status, payload) {
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405
	res.setHeader('allow', allow)
	res.end()
}

/** Message text of an unknown rejection value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/** The composition's connection service (typed locally: its package is browser-side). */
function connectionOf(ctx) {
	return ctx.get('connection')
}

/** Answer an untrusted/unauthenticated request; true when it was rejected. */
function rejected(ctx, req, res) {
	const connection = connectionOf(ctx)
	if (connection === undefined || typeof connection.requestRejection !== 'function') {
		/* Fail closed: without the trust fence there is no way to authenticate a
		 * caller, and this route shuts a process down. */
		res.statusCode = 503
		res.setHeader('content-type', 'text/plain; charset=utf-8')
		res.end('dsh-web-restart: connection trust fence unavailable; refusing the request\n')
		return true
	}
	const rejection = connection.requestRejection(req)
	if (rejection === undefined) return false
	res.statusCode = rejection
	res.end()
	return true
}

/** Expand a leading `~` against the operating-system home. */
function expandHome(path) {
	if (path === '~') return homedir()
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
	return path
}

/**
 * The daemon log every activation record, relauncher note, and daemon startup
 * line is appended to.
 * @param ctx - plugin context carrying the optional `profileContext` service.
 * @param config - the row's raw config.
 * @returns an absolute log file path.
 */
function logFileOf(ctx, config) {
	const configured = typeof config.logPath === 'string' ? config.logPath.trim() : ''
	if (configured !== '') return expandHome(configured)
	const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, LOG_DIR, LOG_NAME)
}

/** Append one timestamped line; logging never fails a restart. */
function appendLog(logFile, message) {
	try {
		mkdirSync(dirname(logFile), { recursive: true })
		appendFileSync(logFile, `${new Date().toISOString()} [${TAG}] ${message}\n`)
	} catch {
		/* the log is a convenience, never a precondition */
	}
}

/** The booted profile's name, from the live profile facts. */
function profileNameOf(ctx) {
	const profile = ctx.get('profileContext')
	if (profile !== undefined && typeof profile.name === 'string' && profile.name !== '') return profile.name
	const fromEnv = process.env.DSH_PROFILE
	return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : 'web'
}

/** Resolve one executable name through `PATH`. */
function findExecutable(command) {
	const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir === '') continue
		for (const extension of extensions) {
			const candidate = join(dir, command + extension)
			try {
				accessSync(candidate, constants.X_OK)
				return candidate
			} catch {
				/* keep looking */
			}
		}
	}
	return undefined
}

/**
 * Extra flags appended after the replayed command line, from the row's config
 * (`extraArgs: ['--trusted-host', 'gui.local']`).
 */
function extraArgsOf(config) {
	const raw = config.extraArgs
	if (!Array.isArray(raw)) return []
	return raw.filter((value) => typeof value === 'string' && value !== '')
}

/** One-line rendering of a command for humans and logs. */
function displayOf(spec) {
	return [spec.command, ...spec.args].map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Group a flat token list into flags and the values that follow them: a token
 * starting with `-` opens a group, every token after it belongs to that group,
 * and any leading value (before the first flag) is ignored.
 * @param args - the token list to group.
 * @returns one `{ flag, values }` entry per flag, in order.
 */
function groupFlags(args) {
	const groups = []
	for (const part of args) {
		if (part.startsWith('-')) groups.push({ flag: part, values: [] })
		else if (groups.length > 0) groups[groups.length - 1].values.push(part)
	}
	return groups
}

/**
 * The argument list of the replacement process, from the replayed argv tail
 * (`process.argv.slice(2)`) and the override block.
 *
 * The replay copies the override block the *previous* restart appended, so
 * appending a fresh block unmodified would grow the command line by one copy
 * per restart. Owned flags are therefore removed first, which makes the block
 * idempotent: exactly one copy survives, and a flag the user passed themselves
 * (`--port 4000`, `--port=4000`) is replaced rather than duplicated.
 *
 * The block goes before a `--` separator when the tail has one: everything after
 * `--` is an operand, `dsh web` declares none and rejects them, so a block placed
 * there would not set the port — it would make the replacement fail to start.
 * @param tail - the replayed arguments (`process.argv.slice(2)`).
 * @param overrides - the override tokens to place last.
 * @returns the replacement's arguments.
 */
function replayArgs(tail, overrides) {
	const owned = groupFlags(overrides)
	const kept = []
	let insertAt = tail.length
	for (let index = 0; index < tail.length; index += 1) {
		const part = tail[index]
		if (part === '--') {
			insertAt = kept.length
			kept.push(...tail.slice(index))
			break
		}
		const group = owned.find((candidate) => part === candidate.flag || part.startsWith(`${candidate.flag}=`))
		if (group === undefined) {
			kept.push(part)
			continue
		}
		/* `--flag=value` carries its value in the same token; `--flag value`
		 * consumes as many values as the override block supplies. */
		if (part === group.flag) index += group.values.length
	}
	kept.splice(insertAt, 0, ...overrides)
	return kept
}

/**
 * The command line that starts this profile again.
 *
 * The replay path uses this process's own argv, which keeps every launcher flag
 * and every overlay intact; the flags in the override block are stripped from it
 * first (`replayArgs`) so a chain of restarts cannot accumulate copies of them.
 * The fallback runs the `dsh` found on `PATH`, which loses overlays but still
 * boots the same profile; it exists for embeddings that do not start through the
 * `dsh` launcher.
 * @param ctx - plugin context carrying the `webServer` service.
 * @param config - the row's raw config.
 * @returns `{ source, command, args }` for the replacement process.
 * @throws when neither the original script nor a `dsh` on `PATH` can be found.
 */
function resolveLaunchSpec(ctx, config) {
	const overrides = ['--no-open', '--port', String(ctx.webServer.port), ...extraArgsOf(config)]
	const script = process.argv[1]
	if (typeof script === 'string' && script !== '' && existsSync(script)) {
		return {
			source: 'argv',
			command: process.execPath,
			args: [script, ...replayArgs(process.argv.slice(2), overrides)],
		}
	}
	const executable = findExecutable('dsh')
	if (executable === undefined) {
		throw new Error('cannot find the dsh launcher to re-run (process.argv[1] is not a readable file and no dsh is on PATH)')
	}
	return {
		source: 'path',
		command: process.execPath,
		args: [executable, '--profile', profileNameOf(ctx), ...overrides],
	}
}

/** The facts the page shows before and while restarting. */
function statusOf(ctx, config, logFile, state) {
	let plan
	let problem
	try {
		plan = resolveLaunchSpec(ctx, config)
	} catch (error) {
		problem = messageOf(error)
	}
	return {
		ok: true,
		pid: process.pid,
		port: ctx.webServer.port,
		host: ctx.webServer.host,
		profile: profileNameOf(ctx),
		/** False when this process already runs without a terminal (our own daemon). */
		terminal: process.stdout.isTTY === true,
		parent: process.ppid,
		uptimeSeconds: Math.round(process.uptime()),
		restarting: state.restarting,
		logFile,
		supported: plan !== undefined,
		source: plan?.source ?? null,
		command: plan === undefined ? problem : displayOf(plan),
		waitsForExitMs: WAIT_FOR_EXIT_MS,
	}
}

/**
 * Mount both routes. Their registrations are effects of this plugin's context,
 * so disabling the row removes them with the plugin.
 * @param ctx - plugin context carrying `webServer` and `connection`.
 * @param config - the row's raw config.
 */
export function apply(ctx, config = {}) {
	const logFile = logFileOf(ctx, config)
	const state = { restarting: false }

	/* Create the log directory now: the restart route opens the log file for the
	 * relauncher, and `openSync` is the only step there that needs the directory. */
	try {
		mkdirSync(dirname(logFile), { recursive: true })
	} catch {
		/* an unusable log path is reported by the restart route instead */
	}

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: STATUS_PATH,
		handler: (req, res) => {
			if (rejected(ctx, req, res)) return
			if (req.method !== 'GET') {
				sendMethodNotAllowed(res, 'GET')
				return
			}
			sendJson(res, 200, statusOf(ctx, config, logFile, state))
		},
	}), `web-restart: GET ${STATUS_PATH}`)

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: RESTART_PATH,
		handler: (req, res) => {
			if (rejected(ctx, req, res)) return
			if (req.method !== 'POST') {
				sendMethodNotAllowed(res, 'POST')
				return
			}
			if (state.restarting) {
				sendJson(res, 409, { ok: false, code: 'in-progress', message: 'a restart is already in progress' })
				return
			}
			let plan
			try {
				plan = resolveLaunchSpec(ctx, config)
			} catch (error) {
				sendJson(res, 500, { ok: false, code: 'unsupported', message: messageOf(error) })
				return
			}
			const spec = {
				pid: process.pid,
				command: plan.command,
				args: plan.args,
				cwd: process.cwd(),
				logFile,
				waitMs: WAIT_FOR_EXIT_MS,
				display: displayOf(plan),
			}
			let launcher
			try {
				const fd = openSync(logFile, 'a')
				try {
					launcher = spawn(process.execPath, [RELAUNCH_SCRIPT, JSON.stringify(spec)], {
						cwd: spec.cwd,
						env: process.env,
						detached: true,
						stdio: ['ignore', fd, fd],
					})
				} finally {
					closeSync(fd)
				}
				launcher.unref()
			} catch (error) {
				sendJson(res, 500, { ok: false, code: 'spawn-failed', message: messageOf(error) })
				return
			}
			state.restarting = true
			appendLog(logFile, `restart requested pid=${String(process.pid)} port=${String(ctx.webServer.port)} relauncher=${String(launcher.pid)} next=${spec.display}`)
			sendJson(res, 202, {
				ok: true,
				pid: process.pid,
				port: ctx.webServer.port,
				relauncher: launcher.pid ?? null,
				command: spec.display,
				logFile,
			})
			/* The launcher's own SIGTERM path disposes the application tree (bounded at 5s),
			 * which closes the server and flushes session state; the answer is already queued. */
			setTimeout(() => {
				try {
					process.kill(process.pid, 'SIGTERM')
				} catch {
					process.exit(0)
				}
			}, RESPONSE_GRACE_MS)
		},
	}), `web-restart: POST ${RESTART_PATH}`)

	/* Last on purpose: the record below is the one line that proves both route
	 * registrations above ran, because `ctx.effect` invokes its callback now and a
	 * throwing registration would abort this plugin's activation instead. */
	ctx.effect(() => {
		appendLog(logFile, `activated pid=${String(process.pid)} tty=${String(process.stdout.isTTY === true)} profile=${profileNameOf(ctx)} port=${String(ctx.webServer.port)} routes=${STATUS_PATH},${RESTART_PATH}`)
		return () => {}
	}, 'web-restart: activation record')
}
