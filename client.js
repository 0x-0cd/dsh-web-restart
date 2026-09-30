/**
 * `dsh-web-restart` — Client half.
 *
 * Two entries in `sidebar.footer.action`, stacked in one column: **shut down**
 * on top, **restart** below it. Both open a small confirmation panel, post to the
 * Host half, and then watch the status route to find out what happened — the
 * watching is the whole point, because the browser cannot render anything from a
 * process that is going down.
 *
 * The two flows differ in what they wait for:
 *
 * - Restart waits for a *different* PID to answer the status route and then
 *   reloads the page; the old process serves for a few hundred milliseconds, so
 *   its PID is the only reliable "still the old server" signal.
 * - Shutdown waits for the route to stop answering at all and then stays put: a
 *   reload would only reach the browser's own error page, so the panel reports
 *   that the service is down instead of pretending it will come back.
 *
 * Everything here is plain React from the browser module table: no Harness
 * Client package is imported, styles are component-local, and all user-visible
 * text comes from this plugin's own locale namespace.
 */

window.__ModuleLoader__.load({
	id: 'dsh-web-restart',
	factory(require) {
		const React = require('react')

		/** Locale namespace owned by this plugin. */
		const NS = 'web-restart'
		/** Host route reporting this process and the restart plan. */
		const STATUS_ROUTE = '/web-restart/status'
		/** Host route performing the restart. */
		const RESTART_ROUTE = '/web-restart/restart'
		/** Host route ending this process without a replacement. */
		const STOP_ROUTE = '/web-restart/stop'
		/** Delay between liveness probes while the server is down. */
		const POLL_INTERVAL_MS = 500
		/** How long the page waits for the new process before giving up. */
		const POLL_TIMEOUT_MS = 90_000
		/** How long the page waits for the process to disappear after a shutdown. */
		const STOP_TIMEOUT_MS = 20_000

		const zh = {
			'action.label': '重启 DSH',
			'action.tooltip': '重启 dsh web 进程（后台守护运行）',
			'dialog.title': '重启 DSH Web',
			'dialog.intro': '安装或更新插件、修改 .env 之后，只有重启进程才会生效。重启会在后台启动一个新的 dsh 守护进程：不占用终端，也不会新开浏览器标签页；服务恢复后本页会自动刷新。',
			'dialog.fact.pid': '进程',
			'dialog.fact.port': '端口',
			'dialog.fact.mode': '运行方式',
			'dialog.fact.mode.terminal': '终端前台',
			'dialog.fact.mode.daemon': '后台守护（无终端）',
			'dialog.fact.log': '日志',
			'dialog.fact.command': '重启命令',
			'dialog.warning': '重启会中断正在进行的回合，未完成的回答需要重新提问。',
			'dialog.cancel': '取消',
			'dialog.confirm': '立即重启',
			'dialog.close': '关闭',
			'progress.title': '正在重启 DSH…',
			'progress.body': '等待服务在后台恢复，恢复后本页会自动刷新，请不要关闭标签页。',
			'progress.command': '新进程命令',
			'progress.timeout': '等待超时：新进程可能在启动时失败了。请查看日志文件，或在终端重新运行 dsh web。',
			'error.title': '无法重启',
			'error.unsupported': '当前进程无法自动重启。',
			'stop.action.label': '关闭 DSH',
			'stop.action.tooltip': '停止 dsh web 进程（不重启，本页会失去连接）',
			'stop.dialog.title': '关闭 DSH Web',
			'stop.dialog.intro': '关闭会终止当前 dsh web 进程，并且不会启动替代进程：页面随即失去连接，正在进行的回合被中断。需要有终端地重新启动时，请在终端运行 dsh web。',
			'stop.dialog.warning': '关闭后不会有进程接手，本页不会自动刷新，也不会重新连上。',
			'stop.dialog.confirm': '立即关闭',
			'stop.progress.title': '正在关闭 DSH…',
			'stop.progress.body': '等待进程退出（优雅退出最多约 5 秒）。本页不会自动刷新，也不会重新连接。',
			'stop.done.title': 'DSH 已关闭',
			'stop.done.body': 'dsh web 进程已停止，服务不会再自己回来。需要使用时请在终端重新运行 dsh web。',
			'stop.error.title': '无法关闭',
			'stop.timeout': '等待超时：进程仍在响应。请查看日志文件确认它是否退出。',
		}

		const en = {
			'action.label': 'Restart DSH',
			'action.tooltip': 'Restart the dsh web process (keeps running as a background daemon)',
			'dialog.title': 'Restart DSH Web',
			'dialog.intro': 'A plugin install or update, or a change to .env, only takes effect after the process restarts. The restart starts a new dsh daemon in the background: it holds no terminal and opens no browser tab, and this page reloads by itself once the server is back.',
			'dialog.fact.pid': 'Process',
			'dialog.fact.port': 'Port',
			'dialog.fact.mode': 'Running as',
			'dialog.fact.mode.terminal': 'Foreground in a terminal',
			'dialog.fact.mode.daemon': 'Background daemon (no terminal)',
			'dialog.fact.log': 'Log',
			'dialog.fact.command': 'Restart command',
			'dialog.warning': 'Restarting interrupts any running turn; an unfinished answer has to be asked again.',
			'dialog.cancel': 'Cancel',
			'dialog.confirm': 'Restart now',
			'dialog.close': 'Close',
			'progress.title': 'Restarting DSH…',
			'progress.body': 'Waiting for the server to come back in the background. This page reloads by itself; keep the tab open.',
			'progress.command': 'New process command',
			'progress.timeout': 'Timed out waiting: the new process probably failed to start. Check the log file, or run dsh web in a terminal again.',
			'error.title': 'Cannot restart',
			'error.unsupported': 'This process cannot restart itself.',
			'stop.action.label': 'Shut down DSH',
			'stop.action.tooltip': 'Stop the dsh web process (no restart; this page loses its connection)',
			'stop.dialog.title': 'Shut down DSH Web',
			'stop.dialog.intro': 'Shutting down terminates the running dsh web process and starts nothing in its place: this page loses its connection and any turn in flight is interrupted. To start it again from a terminal, run dsh web.',
			'stop.dialog.warning': 'Nothing takes over after the shutdown: this page does not reload and does not reconnect.',
			'stop.dialog.confirm': 'Shut down now',
			'stop.progress.title': 'Shutting down DSH…',
			'stop.progress.body': 'Waiting for the process to exit (the graceful path is bounded at about 5s). This page does not reload or reconnect by itself.',
			'stop.done.title': 'DSH is shut down',
			'stop.done.body': 'The dsh web process has stopped and the service will not come back on its own. Run dsh web in a terminal to start it again.',
			'stop.error.title': 'Cannot shut down',
			'stop.timeout': 'Timed out waiting: the process still answers. Check the log file to see whether it exited.',
		}

		const CSS = `
.wrr-footer{display:flex;flex-direction:column;width:100%;min-width:0}
.wrr-footer-rail{width:auto;align-items:center}
.wrr-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:42px;margin:2px 0 0;padding:0 10px 0 8px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden;text-align:left}
.wrr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wrr-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.wrr-row.wrr-rail{flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.wrr-row.wrr-row-danger{color:var(--dsw-alias-state-error-primary)}
.wrr-row.wrr-row-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.wrr-row.wrr-row-danger:focus-visible{outline-color:var(--dsw-alias-state-error-primary)}
.wrr-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wrr-icon{flex:none;display:inline-flex}
.wrr-spin{animation:wrr-spin 1s linear infinite}
@keyframes wrr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wrr-spin{animation:none}}
.wrr-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.wrr-panel{box-sizing:border-box;width:460px;max-width:calc(100vw - 48px);padding:20px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.wrr-panel:focus{outline:none}
.wrr-title{margin:0 0 8px;font-size:16px;font-weight:500;line-height:24px}
.wrr-body{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.wrr-facts{margin:0 0 14px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-family:var(--ds-font-family-code);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.wrr-fact{display:flex;gap:8px}
.wrr-fact-key{flex:none;min-width:72px;color:var(--dsw-alias-label-tertiary)}
.wrr-warning{margin:0 0 14px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}
.wrr-error{margin:0 0 14px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.wrr-actions{display:flex;justify-content:flex-end;gap:8px}
.wrr-btn{box-sizing:border-box;height:32px;padding:0 14px;border:1px solid transparent;border-radius:var(--dsw-radius-md);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.wrr-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wrr-btn-ghost{background:0 0;border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.wrr-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wrr-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.wrr-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.wrr-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.wrr-btn-danger:hover{background:var(--dsw-static-red-500)}
`

		/** Component-local stylesheet: unmounting the entry removes it. */
		function Styles() {
			return React.createElement('style', { 'data-plugin': 'dsh-web-restart' }, CSS)
		}

		/** Rotation arrow used by the restart control. */
		function RestartIcon(props) {
			return React.createElement('svg', {
				width: props.size ?? 16,
				height: props.size ?? 16,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
				focusable: false,
				className: props.className,
			},
			React.createElement('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
			React.createElement('path', { d: 'M21 3v5h-5' }))
		}

		/** Power symbol used by the shutdown control. */
		function PowerIcon(props) {
			return React.createElement('svg', {
				width: props.size ?? 16,
				height: props.size ?? 16,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
				focusable: false,
				className: props.className,
			},
			React.createElement('path', { d: 'M12 2v10' }),
			React.createElement('path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }))
		}

		/** One `key: value` line of the facts block. */
		function Fact(props) {
			return React.createElement('div', { className: 'wrr-fact' },
				React.createElement('span', { className: 'wrr-fact-key' }, props.label),
				React.createElement('span', null, props.value))
		}

		/** Resolve after `ms` milliseconds. */
		function sleep(ms) {
			return new Promise((resolve) => {
				setTimeout(resolve, ms)
			})
		}

		/**
		 * Read the process facts while a panel is open, and remember the PID that
		 * answered: the restart flow needs it to tell the old server from its
		 * replacement, since the old one keeps serving for a few hundred
		 * milliseconds after it has been asked to go down.
		 * @param open - whether the panel is open.
		 * @returns `{ facts, previousPid }`, with `facts` null until the route answers.
		 */
		function useFacts(open) {
			const [facts, setFacts] = React.useState(null)
			const previousPid = React.useRef(null)
			React.useEffect(() => {
				if (!open) return undefined
				let cancelled = false
				fetch(STATUS_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (cancelled || payload === null) return
						previousPid.current = payload.pid
						setFacts(payload)
					})
					.catch(() => {})
				return () => {
					cancelled = true
				}
			}, [open])
			return { facts, previousPid }
		}

		/**
		 * Escape closes an open panel, and the primary action holds focus while it
		 * is open. A panel whose operation is in flight owns the outcome instead,
		 * so it neither closes nor moves focus.
		 * @param open - whether the panel is open.
		 * @param locked - true while the operation is in flight.
		 * @param close - closes the panel.
		 * @param focusRef - ref whose element takes focus when the panel opens.
		 */
		function usePanelKeys(open, locked, close, focusRef) {
			React.useEffect(() => {
				if (!open || locked) return undefined
				const onKeyDown = (event) => {
					if (event.key === 'Escape') close()
				}
				document.addEventListener('keydown', onKeyDown)
				const focus = setTimeout(() => focusRef.current?.focus(), 0)
				return () => {
					document.removeEventListener('keydown', onKeyDown)
					clearTimeout(focus)
				}
			}, [open, locked])
		}

		/** The `key: value` rows every panel shows about the process it acts on. */
		function factRows(facts, t, withCommand) {
			if (facts === null) return []
			const rows = [
				React.createElement(Fact, { key: 'pid', label: t('dialog.fact.pid'), value: `${String(facts.pid)} · ${String(facts.port)}` }),
				React.createElement(Fact, {
					key: 'mode',
					label: t('dialog.fact.mode'),
					value: facts.terminal ? t('dialog.fact.mode.terminal') : t('dialog.fact.mode.daemon'),
				}),
				React.createElement(Fact, { key: 'log', label: t('dialog.fact.log'), value: String(facts.logFile) }),
			]
			if (withCommand && typeof facts.command === 'string' && facts.command !== '') {
				rows.push(React.createElement(Fact, { key: 'command', label: t('dialog.fact.command'), value: facts.command }))
			}
			return rows
		}

		/**
		 * The restart control and its confirmation panel. `props.wide` is false in
		 * the collapsed rail, where the control renders as an icon-only button.
		 * @param props - slot props: `wide` plus the framework-injected `t`.
		 */
		function RestartControl(props) {
			const wide = props.wide !== false
			const t = typeof props.t === 'function' ? props.t : (key) => key
			const [open, setOpen] = React.useState(false)
			const [phase, setPhase] = React.useState('idle')
			const [error, setError] = React.useState('')
			const [command, setCommand] = React.useState('')
			const { facts, previousPid } = useFacts(open)
			const confirmRef = React.useRef(null)

			usePanelKeys(open, phase === 'waiting', () => setOpen(false), confirmRef)

			/* After the Host answered, wait for a *different* process to answer the
			 * same route: the old one is still serving for a few hundred milliseconds,
			 * so its PID is the only reliable "still the old server" signal. */
			React.useEffect(() => {
				if (phase !== 'waiting') return undefined
				let cancelled = false
				const started = Date.now()
				const poll = async () => {
					while (!cancelled) {
						if (Date.now() - started > POLL_TIMEOUT_MS) {
							setPhase('failed')
							setError(t('progress.timeout'))
							return
						}
						await sleep(POLL_INTERVAL_MS)
						if (cancelled) return
						try {
							const response = await fetch(STATUS_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
							if (response.ok) {
								const payload = await response.json()
								if (payload !== null && payload.pid !== previousPid.current) {
									window.location.reload()
									return
								}
							}
						} catch {
							/* the server is down: keep waiting */
						}
					}
				}
				void poll()
				return () => {
					cancelled = true
				}
			}, [phase])

			const restart = async () => {
				setPhase('waiting')
				setError('')
				try {
					const response = await fetch(RESTART_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
					const payload = await response.json().catch(() => null)
					if (!response.ok || payload?.ok !== true) {
						throw new Error(payload?.message ?? `HTTP ${String(response.status)}`)
					}
					if (typeof payload.pid === 'number') previousPid.current = payload.pid
					if (typeof payload.command === 'string') setCommand(payload.command)
				} catch (failure) {
					setPhase('failed')
					setError(failure instanceof Error ? failure.message : String(failure))
				}
			}

			const control = React.createElement('button', {
				type: 'button',
				className: wide ? 'wrr-row' : 'wrr-row wrr-rail',
				'aria-label': t('action.label'),
				title: wide ? undefined : t('action.tooltip'),
				onClick: () => {
					setPhase('idle')
					setError('')
					setOpen(true)
				},
			},
			React.createElement(RestartIcon, { className: 'wrr-icon' }),
			wide ? React.createElement('span', { className: 'wrr-label' }, t('action.label')) : null)

			if (!open) return control

			const busy = phase === 'waiting'
			const failed = phase === 'failed'
			const unsupported = facts !== null && facts.supported === false
			const rows = factRows(facts, t, true)

			const actions = []
			if (busy) {
				/* No action while the process is going down: the page owns the outcome. */
			} else if (failed) {
				actions.push(React.createElement('button', {
					key: 'close',
					type: 'button',
					className: 'wrr-btn wrr-btn-ghost',
					onClick: () => setOpen(false),
				}, t('dialog.close')))
			} else {
				actions.push(React.createElement('button', {
					key: 'cancel',
					type: 'button',
					className: 'wrr-btn wrr-btn-ghost',
					onClick: () => setOpen(false),
				}, t('dialog.cancel')))
				actions.push(React.createElement('button', {
					key: 'confirm',
					ref: confirmRef,
					type: 'button',
					className: 'wrr-btn wrr-btn-primary',
					disabled: unsupported,
					onClick: () => void restart(),
				}, t('dialog.confirm')))
			}

			const panel = React.createElement('div', {
				className: 'wrr-panel',
				role: 'dialog',
				'aria-modal': true,
				'aria-label': busy ? t('progress.title') : t('dialog.title'),
				tabIndex: -1,
			},
			React.createElement('h2', { className: 'wrr-title' }, busy ? t('progress.title') : failed ? t('error.title') : t('dialog.title')),
			busy || failed
				? null
				: React.createElement('p', { className: 'wrr-body' }, unsupported ? t('error.unsupported') : t('dialog.intro')),
			busy ? React.createElement('p', { className: 'wrr-body' }, t('progress.body')) : null,
			unsupported && facts !== null && typeof facts.command === 'string' && facts.command !== ''
				? React.createElement('p', { className: 'wrr-error' }, facts.command)
				: null,
			failed ? React.createElement('p', { className: 'wrr-error' }, error) : null,
			facts !== null && rows.length > 0 ? React.createElement('div', { className: 'wrr-facts' }, rows) : null,
			busy && command !== '' ? React.createElement('div', { className: 'wrr-facts' }, React.createElement(Fact, { label: t('progress.command'), value: command })) : null,
			busy || failed ? null : React.createElement('p', { className: 'wrr-warning' }, t('dialog.warning')),
			actions.length > 0 ? React.createElement('div', { className: 'wrr-actions' }, actions) : null)

			return React.createElement(React.Fragment, null,
				control,
				React.createElement('div', {
					className: 'wrr-mask',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget && !busy) setOpen(false)
					},
				}, panel))
		}

		/**
		 * The shutdown control and its confirmation panel: the same shape as the
		 * restart control, except that it waits for the status route to stop
		 * answering and never reloads the page.
		 * @param props - slot props: `wide` plus the framework-injected `t`.
		 */
		function StopControl(props) {
			const wide = props.wide !== false
			const t = typeof props.t === 'function' ? props.t : (key) => key
			const [open, setOpen] = React.useState(false)
			const [phase, setPhase] = React.useState('idle')
			const [error, setError] = React.useState('')
			const { facts } = useFacts(open)
			const confirmRef = React.useRef(null)

			usePanelKeys(open, phase === 'stopping', () => setOpen(false), confirmRef)

			/* The Host answers before it goes down, so the answer proves only that the
			 * request arrived. The signal that the shutdown happened is the *absence*
			 * of an answer: the graceful path closes the server, and a failed fetch is
			 * the first thing the page can observe from the outside. */
			React.useEffect(() => {
				if (phase !== 'stopping') return undefined
				let cancelled = false
				const started = Date.now()
				const poll = async () => {
					while (!cancelled) {
						await sleep(POLL_INTERVAL_MS)
						if (cancelled) return
						try {
							await fetch(STATUS_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
						} catch {
							if (!cancelled) setPhase('offline')
							return
						}
						if (Date.now() - started > STOP_TIMEOUT_MS) {
							if (!cancelled) {
								setPhase('failed')
								setError(t('stop.timeout'))
							}
							return
						}
					}
				}
				void poll()
				return () => {
					cancelled = true
				}
			}, [phase])

			const stop = async () => {
				setPhase('stopping')
				setError('')
				try {
					const response = await fetch(STOP_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
					const payload = await response.json().catch(() => null)
					if (!response.ok || payload?.ok !== true) {
						throw new Error(payload?.message ?? `HTTP ${String(response.status)}`)
					}
				} catch (failure) {
					setPhase('failed')
					setError(failure instanceof Error ? failure.message : String(failure))
				}
			}

			const control = React.createElement('button', {
				type: 'button',
				className: wide ? 'wrr-row wrr-row-danger' : 'wrr-row wrr-row-danger wrr-rail',
				'aria-label': t('stop.action.label'),
				title: wide ? undefined : t('stop.action.tooltip'),
				onClick: () => {
					setPhase('idle')
					setError('')
					setOpen(true)
				},
			},
			React.createElement(PowerIcon, { className: 'wrr-icon' }),
			wide ? React.createElement('span', { className: 'wrr-label' }, t('stop.action.label')) : null)

			if (!open) return control

			const stopping = phase === 'stopping'
			const offline = phase === 'offline'
			const failed = phase === 'failed'
			const rows = factRows(facts, t, false)

			const actions = []
			if (stopping) {
				/* The process is on its way out; there is nothing left to decide. */
			} else if (offline || failed) {
				actions.push(React.createElement('button', {
					key: 'close',
					type: 'button',
					className: 'wrr-btn wrr-btn-ghost',
					onClick: () => setOpen(false),
				}, t('dialog.close')))
			} else {
				actions.push(React.createElement('button', {
					key: 'cancel',
					type: 'button',
					className: 'wrr-btn wrr-btn-ghost',
					onClick: () => setOpen(false),
				}, t('dialog.cancel')))
				actions.push(React.createElement('button', {
					key: 'confirm',
					ref: confirmRef,
					type: 'button',
					className: 'wrr-btn wrr-btn-danger',
					onClick: () => void stop(),
				}, t('stop.dialog.confirm')))
			}

			const title = stopping
				? t('stop.progress.title')
				: offline
					? t('stop.done.title')
					: failed
						? t('stop.error.title')
						: t('stop.dialog.title')
			const body = stopping
				? t('stop.progress.body')
				: offline
					? t('stop.done.body')
					: failed
						? null
						: t('stop.dialog.intro')

			const panel = React.createElement('div', {
				className: 'wrr-panel',
				role: 'dialog',
				'aria-modal': true,
				'aria-label': title,
				tabIndex: -1,
			},
			React.createElement('h2', { className: 'wrr-title' }, title),
			body === null ? null : React.createElement('p', { className: 'wrr-body' }, body),
			failed ? React.createElement('p', { className: 'wrr-error' }, error) : null,
			facts !== null && rows.length > 0 ? React.createElement('div', { className: 'wrr-facts' }, rows) : null,
			stopping || offline || failed ? null : React.createElement('p', { className: 'wrr-warning' }, t('stop.dialog.warning')),
			actions.length > 0 ? React.createElement('div', { className: 'wrr-actions' }, actions) : null)

			return React.createElement(React.Fragment, null,
				control,
				React.createElement('div', {
					className: 'wrr-mask',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget && !stopping) setOpen(false)
					},
				}, panel))
		}

		/**
		 * The sidebar footer entry: both controls, stacked in one column so the
		 * destructive one stays on top. The footer slot lays its entries out in a
		 * row, so the column has to come from this one entry rather than from two.
		 * @param props - slot props: `wide` plus the framework-injected `t`.
		 */
		function FooterActions(props) {
			const wide = props.wide !== false
			return React.createElement(React.Fragment, null,
				React.createElement(Styles),
				React.createElement('div', { className: wide ? 'wrr-footer' : 'wrr-footer wrr-footer-rail' },
					React.createElement(StopControl, props),
					React.createElement(RestartControl, props)))
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-restart: dictionaries')
				ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
					name: 'sidebar.footer.action',
					id: 'web-restart',
					order: 20,
					locale: NS,
				}, FooterActions))
			},
		}
	},
})
