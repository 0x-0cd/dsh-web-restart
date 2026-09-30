/**
 * Route-level test for the shutdown half of `dsh-web-restart`.
 *
 * `POST /web-restart/stop` ends this process and starts nothing in its place, so
 * the test never lets the real signal through: `process.kill` is replaced with a
 * recorder. That is enough to prove the handler targets its own pid with SIGTERM
 * — rather than falling into the `process.exit(0)` fallback — that the signal
 * lands only after the answer has had time to leave, and that a second request is
 * refused instead of arming a second signal.
 */

const port = 3080
const home = '/tmp/dsh-web-restart-stop-test'
const plugin = await import('../index.js')

/**
 * Activate the plugin against a fake Cordis context.
 * @param config - the row config handed to `apply`.
 * @returns the registered routes, by path.
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
	return routes
}

/**
 * Drive one route handler with a minimal request.
 * @param route - the registered route.
 * @param method - the HTTP method to send.
 * @returns the status, the lower-cased headers, and the parsed JSON body.
 */
function call(route, method) {
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value
		},
		end(chunk) {
			if (typeof chunk === 'string') this.body = chunk
		},
	}
	route.handler({ method, headers: {} }, res)
	let payload = null
	try {
		payload = JSON.parse(res.body)
	} catch {
		payload = null
	}
	return { status: res.statusCode, headers: res.headers, payload }
}

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

let failed = 0
/** @param label - what is being asserted. @param ok - the result. */
function check(label, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detail}`}`)
	if (!ok) failed += 1
}

const routes = mount({})
check('the shutdown route is registered', routes.has('/web-restart/stop'), [...routes.keys()].join(', '))
check('the restart route is still registered', routes.has('/web-restart/restart'))

const status = call(routes.get('/web-restart/status'), 'GET')
check(
	'status reports no restart and no shutdown in flight',
	status.payload?.restarting === false && status.payload?.stopping === false,
	JSON.stringify({ restarting: status.payload?.restarting, stopping: status.payload?.stopping }),
)

/* The handler is destructive by design, so record the signal it sends instead of
 * taking it. Everything below this point depends on the recorder being in place. */
const signals = []
const realKill = process.kill
process.kill = (pid, signal) => {
	signals.push([pid, signal])
	return true
}
try {
	const wrongMethod = call(routes.get('/web-restart/stop'), 'GET')
	check(
		'GET on the shutdown route is 405 with allow: POST',
		wrongMethod.status === 405 && wrongMethod.headers.allow === 'POST',
		`${String(wrongMethod.status)} allow=${String(wrongMethod.headers.allow)}`,
	)
	check('the refused request armed no signal', signals.length === 0, JSON.stringify(signals))

	const accepted = call(routes.get('/web-restart/stop'), 'POST')
	check(
		'POST /web-restart/stop answers 200 ok before going down',
		accepted.status === 200 && accepted.payload?.ok === true,
		JSON.stringify(accepted.payload),
	)
	check(
		'the answer carries this pid and the log path',
		accepted.payload?.pid === process.pid && typeof accepted.payload?.logFile === 'string',
		JSON.stringify(accepted.payload),
	)

	const second = call(routes.get('/web-restart/stop'), 'POST')
	check(
		'a second shutdown request is refused with 409',
		second.status === 409 && second.payload?.code === 'in-progress',
		JSON.stringify(second.payload),
	)

	const during = call(routes.get('/web-restart/status'), 'GET')
	check('status reports the shutdown in flight', during.payload?.stopping === true, JSON.stringify({ stopping: during.payload?.stopping }))

	/* The response grace is 400ms: the signal must not preempt the answer. */
	check('nothing is signalled before the answer has time to leave', signals.length === 0, JSON.stringify(signals))
	await sleep(700)
	check(
		'the handler SIGTERMs its own pid, exactly once',
		signals.length === 1 && signals[0][0] === process.pid && signals[0][1] === 'SIGTERM',
		JSON.stringify(signals),
	)
} finally {
	process.kill = realKill
}

console.log(failed === 0 ? 'STOP ROUTE OK' : `STOP ROUTE FAILED (${String(failed)})`)
process.exitCode = failed === 0 ? 0 : 1
