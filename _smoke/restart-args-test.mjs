/**
 * Regression test for the restart command line `dsh-web-restart` builds.
 *
 * Bug pinned down here: the override block (`--no-open --port <port>`) was
 * appended to a verbatim replay of `process.argv`, and the process being
 * replaced had itself been started with that block, so every restart added one
 * more copy:
 *
 *   dsh web --no-open --port 3080 --no-open --port 3080 --no-open --port 3080
 *
 * The test drives the real `/web-restart/status` route (never `/restart`) and
 * feeds each planned command line back in as the next process's argv — a
 * fixed-point iteration over the plugin's own output — then asserts the plan
 * stops growing after the first restart.
 */

import { fileURLToPath } from 'node:url'

const node = process.execPath
const pluginDir = fileURLToPath(new URL('../', import.meta.url))
const script = fileURLToPath(new URL('../index.js', import.meta.url))
const home = '/tmp/dsh-web-restart-args-test'
const port = 3080

const plugin = await import('../index.js')

/**
 * Activate the plugin against a fake Cordis context.
 * @param config - the row config handed to `apply`.
 * @returns the status route handler.
 */
function mount(config) {
	const routes = new Map()
	const ctx = {
		get(key) {
			if (key === 'connection') return { requestRejection: () => undefined }
			if (key === 'profileContext') return { name: 'web', home }
			return undefined
		},
		effect(callback) {
			return callback()
		},
		webServer: {
			port,
			host: '127.0.0.1',
			register(route) {
				routes.set(route.path, route)
				return () => routes.delete(route.path)
			},
		},
	}
	plugin.apply(ctx, config)
	return routes.get('/web-restart/status')
}

/**
 * The command line this process would start, for a given argv tail.
 * @param status - the status route handler.
 * @param tail - `process.argv.slice(2)` of the process being replaced.
 * @returns the planned command line.
 */
function plan(status, tail) {
	process.argv = [node, script, ...tail]
	const res = {
		statusCode: 0,
		body: '',
		setHeader() {},
		end(chunk) {
			if (typeof chunk === 'string') this.body = chunk
		},
	}
	status.handler({ method: 'GET', headers: {} }, res)
	const payload = JSON.parse(res.body)
	if (payload.supported !== true) throw new Error(`no launch plan: ${String(payload.command)}`)
	return payload.command
}

/** Split a display line into tokens (bare, or JSON-quoted when it has a space). */
function tokensOf(text) {
	const parts = []
	let index = 0
	while (index < text.length) {
		if (text[index] === ' ') {
			index += 1
			continue
		}
		if (text[index] === '"') {
			let end = index + 1
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
			parts.push(JSON.parse(text.slice(index, end + 1)))
			index = end + 1
			continue
		}
		const end = text.indexOf(' ', index)
		if (end === -1) {
			parts.push(text.slice(index))
			break
		}
		parts.push(text.slice(index, end))
		index = end
	}
	return parts
}

/** Count non-overlapping occurrences of a token in a display line. */
function countOf(text, token) {
	return text.split(token).length - 1
}

/**
 * Restart `rounds` times, each time feeding the planned command line back in.
 * @param config - the row config.
 * @param start - argv tail of the first process.
 * @param rounds - how many restarts to simulate.
 * @returns one planned command line per round.
 */
function chain(config, start, rounds) {
	const status = mount(config)
	const lines = []
	let tail = start
	for (let round = 0; round < rounds; round += 1) {
		const command = plan(status, tail)
		lines.push(command)
		/* The child this restart spawns has the planned command line as its own
		 * argv: `[node, script, ...args]`. That argv is what the next restart
		 * replays, so the iteration below is the real restart loop. */
		tail = tokensOf(command).slice(2)
	}
	return lines
}

let failed = 0
/** @param label - what is being asserted. @param ok - the result. */
function check(label, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detail}`}`)
	if (!ok) failed += 1
}

const clean = `${node} ${script} web --no-open --port 3080`

/* 1 ── the reported bug: a plain `dsh web` restart chain must not grow. */
const chainLines = chain({}, ['web'], 12)
console.log('round  1:', chainLines[0])
console.log('round 12:', chainLines[11])
check('first restart appends exactly one override block', chainLines[0] === clean, chainLines[0])
check(
	'twelve restarts keep the same command line',
	chainLines.every((line) => line === clean),
	chainLines.find((line) => line !== clean),
)

/* 2 ── a process already poisoned by the old code is cleaned by one restart. */
const poisoned = ['web', ...Array.from({ length: 9 }, () => ['--no-open', '--port', '3080']).flat()]
const healed = chain({}, poisoned, 1)
check('a 9-copy command line collapses back to one block in a single restart', healed[0] === clean, healed[0])

/* 3 ── the user's own port flag is replaced, not duplicated or kept. */
for (const tail of [['web', '--port', '0'], ['web', '--port=4000'], ['web', '--port', '4000']]) {
	const line = chain({}, tail, 4)[3]
	check(`\`${tail.slice(1).join(' ')}\` is replaced by the live port`, line === clean, line)
}

/* 4 ── every other launcher flag survives, one copy each. */
const keptTail = ['--profile', 'web', '--patch', '/tmp/overlay.yml', 'web', '--trusted-host', 'gui.local']
const keptExpected = `${node} ${script} --profile web --patch /tmp/overlay.yml web --trusted-host gui.local --no-open --port 3080`
const keptLines = chain({}, keptTail, 5)
check('unowned flags are replayed verbatim', keptLines[0] === keptExpected, keptLines[0])
check('unowned flags are not duplicated across restarts', keptLines.every((line) => line === keptExpected), keptLines[4])

/* 5 ── configured extraArgs is part of the block, so it is idempotent too. */
const extraLines = chain({ extraArgs: ['--trusted-host', 'gui.local'] }, ['web'], 6)
const extraExpected = `${node} ${script} web --no-open --port 3080 --trusted-host gui.local`
check('extraArgs lands once in the override block', extraLines[0] === extraExpected, extraLines[0])
check('extraArgs is not duplicated across restarts', extraLines.every((line) => line === extraExpected), extraLines[5])

/* 6 ── the block stays in the option region: after `--` it would be an operand,
 * and `dsh web` rejects operands, so the replacement would fail to start. */
const afterSeparator = chain({}, ['web', '--'], 3)
const separatorExpected = `${node} ${script} web --no-open --port 3080 --`
check('the override block is placed before a `--` separator', afterSeparator[0] === separatorExpected, afterSeparator[0])
check('a `--` separator stays idempotent', afterSeparator.every((line) => line === separatorExpected), afterSeparator[2])

/* 7 ── the same, verified with the real parser when the CLI is installed. */
try {
	const { createRequire } = await import('node:module')
	const { pathToFileURL } = await import('node:url')
	/* Resolve commander through the installed `dsh` CLI, so the check uses the
	 * very parser (and version) the replacement process will be read by. */
	const require = createRequire('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
	const { Command } = await import(pathToFileURL(require.resolve('commander')).href)
	/** A fresh `dsh web` command, with the error output muted. */
	const webCommand = () => {
		const program = new Command()
			.name('dsh --profile web')
			.exitOverride()
			.option('--host <host>')
			.option('--no-open')
			.option('--port <port>')
			.option('--trusted-host <authority...>')
		program.action(() => {})
		program.configureOutput({ writeErr: () => {} })
		return program
	}
	/** The arguments `dsh web` itself parses, from a planned command line. */
	const webArgsOf = (line) => {
		const args = tokensOf(line).slice(2)
		return args[0] === 'web' ? args.slice(1) : undefined
	}
	let parseFailed = 0
	let parsed = 0
	for (const line of [...chainLines, ...afterSeparator, ...extraLines]) {
		const args = webArgsOf(line)
		if (args === undefined) continue
		parsed += 1
		try {
			webCommand().parse(args, { from: 'user' })
		} catch (error) {
			parseFailed += 1
			console.log('        rejected by commander:', line, '->', error.message)
		}
	}
	check(`the real \`dsh web\` parser accepts every planned command line (${String(parsed)} parsed)`, parseFailed === 0)
	/* The parser must resolve the live port from the block, exactly once. */
	const program = webCommand().parse(webArgsOf(chainLines[11]), { from: 'user' })
	const opts = program.opts()
	check('the parser resolves one port, equal to the live port', opts.port === '3080' && countOf(chainLines[11], '--port') === 1, JSON.stringify(opts))
	/* And a `--` tail must not turn the block into rejected operands. */
	let separatorRejected = false
	try {
		webCommand().parse(webArgsOf(separatorExpected), { from: 'user' })
	} catch {
		separatorRejected = true
	}
	check('the `--` case parses (the block sits before the separator)', separatorRejected === false, separatorExpected)
} catch (error) {
	console.log(`SKIP  real-parser check (${error.message})`)
}

process.argv = process.argv.slice(0, 2)
console.log(failed === 0 ? 'RESTART ARGS OK' : `RESTART ARGS FAILED (${String(failed)})`)
process.exitCode = failed === 0 ? 0 : 1
