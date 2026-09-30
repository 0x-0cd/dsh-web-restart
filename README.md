# dsh-web-restart

在 dsh Web GUI 里一键重启 `dsh web` 进程，并让它以**后台守护进程**的方式继续运行。

装插件 / 改 `$DSH_HOME/.env` 之后必须重启进程才生效，以前只能回到终端 Ctrl-C 再敲一遍 `dsh web`。
这个插件把这一步搬进页面：侧边栏底部（Settings 上方）多一个「重启 DSH」按钮，点确认后：

1. Host 侧先把一个分离的 relauncher 拉起来（`relaunch.js`，独立会话，stdout/stderr 指向日志文件）；
2. 当前进程走启动器自己的优雅退出路径（`SIGTERM` → 释放插件树 → 关闭 HTTP 服务，最多 5 秒）；
3. relauncher 等到旧 PID 消失后，用**原来一模一样的命令行**启动新进程，并追加 `--no-open --port <当前端口>`；
   追加前会先摘掉命令行里已有的同名 flag，所以重启多少次都只有一份覆盖块（见下「重启命令行」）；
4. 浏览器页面轮询 `/web-restart/status`，等到**另一个 PID** 应答后自动 `location.reload()`。

重启后的 dsh 没有控制终端、stdin 是 `/dev/null`、输出进日志文件，所以关掉原来的终端也不会被带走，也不会再弹一个新标签页。

## 使用

侧边栏底部 → **重启 DSH** → 确认面板里能看到当前 PID / 端口 / 运行方式 / 日志路径 / 将要执行的命令 → **立即重启**。

面板打开时按 `Esc` 或点遮罩可取消；重启过程中页面会一直等待（最长 90 秒），超时会提示去看日志。

## 为什么刷新后还登录着

浏览器 cookie 由 `$DSH_HOME/.credentials.yaml` 里的持久密钥签名，并且和请求的 authority（`host:port`）绑定。
插件因此强制把新进程钉在**当前端口**上（`--no-open --port <当前端口>` 追加在选项区末尾，覆盖原来的 `--port 0` 或旧值），
刷新后 cookie 依然有效，页面不会落到 401。

## 重启命令行（为什么反复重启不会越叠越长）

新进程的命令行 = **当前进程的 `process.argv` 原样重放** + 覆盖块 `--no-open --port <当前端口> [extraArgs...]`。
问题是「当前进程」本身就是上一次重启的产物，它的 argv 里已经带着上一份覆盖块；无脑追加就会每重启一次多一份：

```text
# 修好之前，重启 9 次后的实际命令行
dsh web --no-open --port 3080 --no-open --port 3080 ... （重复 9 遍）
```

所以追加前先用 `replayArgs()` 做去重：把 argv 里**本插件自己拥有的 flag**（`--no-open`、`--port`，以及 config 里的 `extraArgs`）连值一起摘掉，再插入新的一份。
三个附带效果：

- 用户自己写的 `--port 0` / `--port 4000` / `--port=4000` 是被**替换**（而不是并存两份，也不是被保留）；
- 其余 flag（`--profile`、`--patch`、`--trusted-host` …）原样保留，各一份；
- argv 里若出现 `--` 分隔符，覆盖块插在它**前面**：`--` 之后是操作数，而 `dsh web` 不接受操作数，
  插在后面会让新进程直接起不来（commander 报 `too many arguments`），而不是改端口失败。

回归测试：`node _smoke/restart-args-test.mjs`(仓库根目录；把规划出的命令行再喂回去做不动点迭代，并用 dsh 自带的 commander 真解析一遍）。

## 日志

默认 `<DSH_HOME>/logs/web-daemon.log`，同一个文件里能看到：

- `[web-restart] activated ...` —— 每次进程启动（含从终端手动启动的那次）；
- `[web-restart] restart requested ... next=<命令>` —— 谁在什么时候点了重启；
- `[web-restart/relaunch] ...` —— relauncher 的等待与启动记录；
- 新守护进程自己的全部 stdout/stderr，包括 `dsh web: <url>` 那一行。

如果新进程起不来，日志会给出原因；另外 dsh 自己还会在 `<DSH_HOME>/logs/` 写一份 `startup-*.log` 崩溃报告。

## 配置（可选）

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里覆盖本插件的行：

```yaml
- id: web-restart
  name: dsh-web-restart
  config:
    logPath: ~/.dsh/logs/web-daemon.log   # 守护进程日志位置
    extraArgs: []                          # 追加到重启命令行的额外参数
```

这两个字段直接从行 config 读取，插件没有声明 Config schema，所以 Settings → 插件页面里不会出现配置表单。

## 边界

- 重启会中断正在进行的回合（面板里有提示）。
- 路由 `/web-restart/status`、`/web-restart/restart` 和 dsh 其它浏览器路由共用同一道
  `connection.requestRejection` 围栏：Host/Origin 检查 + 浏览器会话 cookie，未认证请求拿不到任何信息。
- 重启命令行优先复用当前进程的 `process.argv`（`--profile`、`--patch`、`--trusted-host` 全部保留）；
  覆盖块（`--no-open --port`、`extraArgs`）在复用前先去掉 argv 里的旧值，因此是幂等的；
  只有在拿不到 argv[1] 时才回退到 PATH 上的 `dsh --profile <name>`（此时自定义 overlay 会丢）。
- 只支持 web profile：`/web-restart/*` 路由由 `webServer` 提供，其它前端组合里这两个路由不会挂载。

## English

Adds a **Restart DSH** control to the Web GUI sidebar foot. It restarts the
`dsh web` process through the launcher's own graceful `SIGTERM` path, and the
replacement runs detached — no controlling terminal, stdin on `/dev/null`,
stdout/stderr appended to `<DSH_HOME>/logs/web-daemon.log` — so it survives the
terminal it was started from. The page polls `/web-restart/status` and reloads
itself once a new PID answers. The original command line is replayed verbatim
with `--no-open --port <current port>` appended, which keeps launcher flags and
keeps the browser's authority-bound session cookie valid. The plugin's own flags
are removed from the replay before the fresh block is appended, so a chain of
restarts keeps exactly one copy instead of growing by one block per restart.

Regression test: `node _smoke/restart-args-test.mjs` (from the repo root).
