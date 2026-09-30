/**
 * Render test for the client half of `dsh-web-restart`.
 *
 * The browser half has no other coverage: it is plain React handed to
 * `window.__ModuleLoader__`, and React itself only exists in the Web app's module
 * table. A compact stub stands in for it here — element tree, hook slots, and
 * effects — which is enough to drive the real component through both flows:
 *
 * - the footer renders the destructive control *above* the restart control, with
 *   the red/danger classes and the matching stylesheet rules;
 * - confirming the shutdown posts to `/web-restart/stop` and then, once the
 *   status route stops answering, settles on "shut down" without reloading the
 *   page (a reload would only reach the browser's own error page);
 * - confirming the restart still posts to `/web-restart/restart` and reloads once
 *   a different PID answers, which is the behaviour the shared hooks must keep.
 *
 * `fetch` is a stub and nothing touches the live server.
 */

/* ── a React small enough to be honest about: createElement + three hooks ──── */

const Fragment = Symbol('Fragment')

const stores = new Map()
let current = { hooks: [], cursor: 0 }
let dirty = false
let pending = []

/** @param type - element type. @param props - element props. @param children - children. */
function createElement(type, props, ...children) {
	return { type, props: { ...(props ?? {}), children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) } }
}

/** @param initial - lazy or direct initial value. @returns `[value, setValue]`. */
function useState(initial) {
	const store = current
	const index = store.cursor++
	if (!(index in store.hooks)) store.hooks[index] = typeof initial === 'function' ? initial() : initial
	const setValue = (value) => {
		store.hooks[index] = typeof value === 'function' ? value(store.hooks[index]) : value
		dirty = true
	}
	return [store.hooks[index], setValue]
}

/** @param initial - initial `current`. @returns the stable ref object. */
function useRef(initial) {
	const store = current
	const index = store.cursor++
	if (!(index in store.hooks)) store.hooks[index] = { current: initial }
	return store.hooks[index]
}

/** @param fn - effect body. @param deps - dependency list. */
function useEffect(fn, deps) {
	const store = current
	const index = store.cursor++
	const previous = store.hooks[index]
	const changed = previous === undefined
		|| deps === undefined
		|| previous.deps.length !== deps.length
		|| deps.some((dep, at) => !Object.is(dep, previous.deps[at]))
	if (!changed) return
	if (previous?.cleanup !== undefined) previous.cleanup()
	store.hooks[index] = { deps: deps ?? [], cleanup: undefined }
	pending.push({ slot: store.hooks[index], fn })
}

const React = { Fragment, createElement, useState, useRef, useEffect }

/* ── commit: call function components, keep per-component hook slots ───────── */

/** @param node - an element, array, or text. @returns a normalised tree node. */
function expand(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return null
	if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
	if (Array.isArray(node)) return node.map(expand).flat().filter(Boolean)
	if (node.type === Fragment) return node.props.children.map(expand).flat().filter(Boolean)
	if (typeof node.type === 'function') {
		const saved = current
		let store = stores.get(node.type)
		if (store === undefined) {
			store = { hooks: [], cursor: 0 }
			stores.set(node.type, store)
		}
		store.cursor = 0
		current = store
		let out
		try {
			out = node.type(node.props)
		} finally {
			current = saved
		}
		return expand(out)
	}
	return { kind: 'host', type: node.type, props: node.props, children: node.props.children.map(expand).flat().filter(Boolean) }
}

/** @param component - the component to render. @param props - its props. @returns the tree. */
function render(component, props) {
	let tree
	let guard = 0
	do {
		dirty = false
		pending = []
		tree = expand(createElement(component, props))
		for (const effect of pending) {
			const cleanup = effect.fn()
			if (typeof cleanup === 'function') effect.slot.cleanup = cleanup
		}
		guard += 1
	} while (dirty && guard < 30)
	return tree
}

/** @param node - tree or subtree. @param out - accumulator. @returns every host node. */
function hosts(node, out = []) {
	if (node === null || node === undefined) return out
	if (Array.isArray(node)) {
		for (const child of node) hosts(child, out)
		return out
	}
	if (node.kind === 'host') {
		out.push(node)
		for (const child of node.children) hosts(child, out)
	}
	return out
}

/** @param node - tree or subtree. @param out - accumulator. @returns every string in it. */
function texts(node, out = []) {
	if (node === null || node === undefined) return out
	if (Array.isArray(node)) {
		for (const child of node) texts(child, out)
		return out
	}
	if (node.kind === 'text') out.push(node.text)
	else if (node.kind === 'host') for (const child of node.children) texts(child, out)
	return out
}

/** @param node - tree or subtree. @returns every button host node, in order. */
function buttons(node) {
	return hosts(node).filter((host) => host.type === 'button')
}

/* ── stubs: module loader, DOM, fetch, location ───────────────────────────── */

const reloads = []
let captured = null
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			captured = spec
		},
	},
	location: {
		reload() {
			reloads.push(Date.now())
		},
	},
}
globalThis.document = { addEventListener() {}, removeEventListener() {} }

const calls = []
let mode = 'idle'
/** @param payload - the JSON body. @returns a minimal `Response`. */
function okJson(payload) {
	return { ok: true, status: 200, json: async () => payload }
}
globalThis.fetch = async (url, options = {}) => {
	const method = options.method ?? 'GET'
	calls.push(`${method} ${url}`)
	if (url === '/web-restart/stop') {
		mode = 'stopping'
		return okJson({ ok: true, pid: 111, port: 3080, logFile: '/tmp/wrr-test.log' })
	}
	if (url === '/web-restart/restart') {
		mode = 'restarted'
		return okJson({ ok: true, pid: 111, command: 'node index.js web --no-open --port 3080', logFile: '/tmp/wrr-test.log' })
	}
	if (url === '/web-restart/status') {
		/* The shutdown closes the server: the first probe after it fails. */
		if (mode === 'stopping') throw new TypeError('fetch failed')
		return okJson({
			ok: true,
			pid: mode === 'restarted' ? 222 : 111,
			port: 3080,
			host: '127.0.0.1',
			profile: 'web',
			terminal: false,
			logFile: '/tmp/wrr-test.log',
			supported: true,
			command: 'node index.js web --no-open --port 3080',
		})
	}
	throw new Error(`unexpected request: ${method} ${url}`)
}

/* ── drive the real module ────────────────────────────────────────────────── */

await import('../client.js')

let failed = 0
/** @param label - what is being asserted. @param ok - the result. */
function check(label, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detail}`}`)
	if (!ok) failed += 1
}
/** Resolve after `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

check('the module registers itself as dsh-web-restart', captured?.id === 'dsh-web-restart')

const dictionaries = { zh: null, en: null }
let registered = null
const factory = captured.factory((name) => {
	if (name === 'react') return React
	throw new Error(`the client half asked for an unexpected module: ${name}`)
})
factory.apply({
	effect(callback) {
		return callback()
	},
	locale: {
		register(namespace, value) {
			dictionaries.zh = value.zh
			dictionaries.en = value.en
			return () => {}
		},
	},
	slots: {
		inject(name, register) {
			return register()
		},
		register(spec, component) {
			registered = { spec, component }
			return () => {}
		},
	},
})

check('it registers into sidebar.footer.action', registered?.spec?.name === 'sidebar.footer.action', JSON.stringify(registered?.spec))
check('the slot entry keeps its id, order and locale namespace', registered?.spec?.id === 'web-restart' && registered?.spec?.order === 20 && registered?.spec?.locale === 'web-restart', JSON.stringify(registered?.spec))

const props = { wide: true, t: (key) => key }
let tree = render(registered.component, props)

/* ── the footer: both controls, destructive one first ─────────────────────── */

const initial = buttons(tree)
check('the footer renders exactly two buttons', initial.length === 2, initial.map((button) => button.props.className).join(' | '))
check('the shutdown control comes first, above the restart control', initial[0]?.props['aria-label'] === 'stop.action.label' && initial[1]?.props['aria-label'] === 'action.label', `${String(initial[0]?.props['aria-label'])} then ${String(initial[1]?.props['aria-label'])}`)
check('the shutdown control carries the danger class', String(initial[0]?.props.className).includes('wrr-row-danger'), String(initial[0]?.props.className))
check('the restart control does not', !String(initial[1]?.props.className).includes('danger'), String(initial[1]?.props.className))
check('both sit in the column wrapper the footer row needs', hosts(tree).some((host) => host.props.className === 'wrr-footer'), hosts(tree).map((host) => host.props.className).filter(Boolean).join(' | '))
check('the shutdown control draws a power glyph', hosts(initial[0]).some((host) => host.type === 'svg'), initial[0]?.children?.map((child) => child.type).join(','))
check('the restart control still draws its arrow', hosts(initial[1]).some((host) => host.type === 'svg'))

const css = texts(tree).join('\n')
check('the stylesheet colours the control red', css.includes('.wrr-row.wrr-row-danger{color:var(--dsw-alias-state-error-primary)}'))
check('the stylesheet gives it a light red hover', css.includes('.wrr-row.wrr-row-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}'))

/* ── every label rendered has both dictionaries ───────────────────────────── */

const seen = new Set()
/**
 * Collect the locale keys one rendered tree asks for.
 * @param node - tree or subtree.
 */
function collectKeys(node) {
	if (node === null || node === undefined) return
	if (Array.isArray(node)) {
		for (const child of node) collectKeys(child)
		return
	}
	if (node.kind === 'text' && /^(action|dialog|progress|error|stop)\./.test(node.text)) seen.add(node.text)
	if (node.kind === 'host') for (const child of node.children) collectKeys(child)
}

/** @param label - the `aria-label` of the sidebar control to find. */
function control(label) {
	const found = buttons(tree).find((button) => button.props['aria-label'] === label)
	if (found === undefined) throw new Error(`no control labelled ${label}`)
	return found
}

/** @param className - the class identifying the button to find. */
function buttonWith(className) {
	return buttons(tree).find((button) => String(button.props.className).includes(className))
}

collectKeys(tree)

/* ── the shutdown flow: post, wait for silence, do not reload ─────────────── */

control('stop.action.label').props.onClick()
tree = render(registered.component, props)
await sleep(20)
tree = render(registered.component, props)
collectKeys(tree)
const stopConfirm = buttonWith('wrr-btn-danger')
check('opening the shutdown control shows a danger-styled confirm button', stopConfirm !== undefined, buttons(tree).map((button) => button.props.className).join(' | '))
check('the panel offers a cancel alongside it', buttonWith('wrr-btn-ghost') !== undefined)
check('the shutdown panel warns that nothing takes over', texts(tree).includes('stop.dialog.warning'))
check('the shutdown panel names the process it will end', texts(tree).includes('dialog.fact.pid'))

stopConfirm.props.onClick()
/* Render once so the panel enters its stopping phase: the poll is an effect. */
tree = render(registered.component, props)
collectKeys(tree)
check('the panel reports the shutdown in progress', texts(tree).includes('stop.progress.title'), texts(tree).filter((text) => text.startsWith('stop.')).join(', '))
await sleep(700)
tree = render(registered.component, props)
collectKeys(tree)
const afterStop = texts(tree)
check('confirming posts to the shutdown route', calls.includes('POST /web-restart/stop'), calls.join(', '))
check('it never posts to the restart route', !calls.includes('POST /web-restart/restart'), calls.join(', '))
check('the panel settles reporting the service is down', afterStop.includes('stop.done.title') && afterStop.includes('stop.done.body'), afterStop.filter((text) => text.startsWith('stop.')).join(', '))
check('the page is not reloaded after a shutdown', reloads.length === 0, `${String(reloads.length)} reload(s)`)

buttonWith('wrr-btn-ghost').props.onClick()
tree = render(registered.component, props)

/* ── the restart flow still works, reload and all ─────────────────────────── */

mode = 'idle'
control('action.label').props.onClick()
tree = render(registered.component, props)
await sleep(20)
tree = render(registered.component, props)
collectKeys(tree)
const restartConfirm = buttonWith('wrr-btn-primary')
check('opening the restart control still shows its primary confirm', restartConfirm !== undefined, buttons(tree).map((button) => button.props.className).join(' | '))
check('the restart panel still names the command it would run', texts(tree).includes('dialog.fact.command'))

restartConfirm.props.onClick()
/* Render once so the panel starts polling for a different PID. */
tree = render(registered.component, props)
collectKeys(tree)
await sleep(900)
check('confirming posts to the restart route', calls.includes('POST /web-restart/restart'), calls.join(', '))
check('a new PID answering reloads the page', reloads.length === 1, `${String(reloads.length)} reload(s)`)

const missing = [...seen].filter((key) => !(key in dictionaries.zh) || !(key in dictionaries.en))
check(`both dictionaries cover every label rendered (${String(seen.size)} keys)`, missing.length === 0, missing.join(', '))

console.log(failed === 0 ? 'CLIENT RENDER OK' : `CLIENT RENDER FAILED (${String(failed)})`)
process.exitCode = failed === 0 ? 0 : 1
