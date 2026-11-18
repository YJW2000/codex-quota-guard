# Codex 额度守卫 0.4.1

[简体中文](README.md) · [繁體中文](docs/README.zh-Hant.md) · [English](docs/README.en.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md)

[下载 Windows 安装包（v0.4.1）](https://github.com/YJW2000/codex-quota-guard/releases/download/v0.4.1/codex-quota-guard-v0.4.1-windows.zip)

保留真实额度监控、低额度自动暂停、排队、恢复后续跑和等待时防睡眠。取消用户级/系统级 `CODEX_CLI_PATH` 启动覆盖；监控故障不会成为普通 Codex 启动或登录的依赖。

## 已定位的旧版故障

桌面启动会执行 `app-server --print-startup-config --startup-client-info ...`，标准输入设为 `ignore`。0.1 的原生程序把它误判为长期 RPC 会话；Node 桥接在标准输入结束时关闭会话，而一次性配置输出又通过已关闭的 Peer 转发，最终丢失输出。另有在子进程 `exit` 而不是输出流排空后的 `close` 时结束输出的问题。

用本机原版 CLI 和 0.1 原始代码对照：原版退出码 0，返回 **122 字节有效 JSON**；旧桥接退出码 0，返回 **0 字节**；修复版返回相同的 **122 字节有效 JSON**。这复现并修复了组织配置启动链上的具体兼容缺陷；真实 GUI 的组织设置和登录回归尚未执行，不能据此宣称 GUI 已测试。

## 两种使用方式

**日常独立监控：** 单独启动原版 CLI 的只读 `app-server`，仅进行初始化与 `account/rateLimits/read`。托盘和可选 MCP 通过带令牌的本机管道读取状态。失败、超时、崩溃、缺失或过期显示“暂不可用”，不猜测额度。

**完整自动守卫：** 本机 Windows 桌面引擎通过私有 stdio 运行，当前安装版本没有可供独立监控连接的受支持共享控制接口。因此，自动暂停和续跑通过**可选的单次会话桥接**保留。专用启动脚本先验证启动配置和协议，仅对新启动的桌面子进程设置环境；普通快捷方式和 User/Machine 环境变量不变。已有桌面不会被强行退出或注入。

- 默认预留 5%。服务返回的 5 小时窗口（300 分钟）剩余额度达到或低于阈值时，在已连接引擎的所有已加载聊天中保存恢复记录并中断正在执行的任务，包括可见子任务。
- 新请求按原始参数持久化、按客户端标识去重；收到排队确认后才提交。响应丢失或超时的未确认记录不会自动重放。
- 5 小时窗口高于阈值且账号允许使用时，下一次查询/额度通知触发原聊天续跑；默认轮询 30 秒，重连间隔 1 秒。不会仅凭预计重置时间启动任务。
- 同一聊天顺序派发，不同聊天可并行。取消、归档、独立推进的旧轮次不强行复活；审批/用户输入仍由用户确认。派发结果不确定时标记人工核对，不盲目重试。
- 额度未知或监控失败时不自动中断、不自动续跑，正常请求直接转交原版引擎。后台恢复后桥接重新连接。排队时可请求防睡眠；后台退出即释放请求。
- 作用范围是经专用入口启动且已连接的引擎；其他普通启动的 Codex、其他终端或设备不受控制。无法保证休眠、断网或程序关闭期间“立刻”恢复。

## 安装与重新启用

**使用 Windows 安装包。** 需要 Node.js 22 或更新版本和 .NET Framework 4.x。解压 ZIP 后，双击 `install.cmd` 安装并启动独立监控。自动暂停和续跑请使用下方的专用启动入口。

要求 Windows、Node.js 22+、系统 .NET Framework 4.x。从**修复后的源码目录**运行，不要使用旧缓存里的脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-monitor.ps1
```

安装先运行检查、测试和编译，再更新本插件文件。没有可用 CLI 时独立监控显示“暂不可用”。正在运行的本插件桥接会阻止覆盖安装，需先正常退出该旧会话或旧托盘；脚本不会按名称结束 Codex。更新独立监控前会停止本插件后台和托盘，完成后再次运行 `start-monitor.ps1`。

需要自动暂停/续跑时，先保存工作并**正常完全退出 Codex**，再在外部 PowerShell 运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-guarded-codex.ps1
```

该入口从 Windows 应用清单解析实际桌面程序。启动后需要本次会话标识对应的引擎完成握手，超时将提示未确认接入。启动前执行只读预检：原版与桥接的一次性启动配置必须一致，且初始化、`configRequirements/read`、`config/read` 必须通过。失败自动用原版入口启动桌面，保留独立监控；不会写入用户级变量。预检通过不等于真实 GUI 登录测试。托盘“查看自动控制”应显示已连接引擎；0 个表示目前仅有独立监控。

若需要恢复 Codex 内的 MCP 工具注册，可显式使用 `install.ps1 -RegisterPlugin`，然后在 Codex 插件设置启用本插件。它只操作自己的 marketplace/插件；不把监控设为 required。独立监控和会话桥接不依赖 MCP 成功连接。`-AutoStart` 仅创建监控托盘的 Startup 快捷方式，不自动启动或接管 Codex。

## 邮件提醒

守卫通过已绑定的 Gmail 发送五小时和周额度提醒，两类邮件使用同一个收件地址。首次绑定时默认发给自己。已确认中断或暂缓对话后发送五小时提醒，同一账号同一次低额度期间的多个任务合并提示。独立监控读到周窗口（10080 分钟）达到阈值时，即使桌面尚未连接也会发送周额度提醒，对话继续使用剩余周额度。服务只返回周窗口时，五小时状态显示暂不可用。

安装后运行以下命令，核对并绑定当前 Gmail。绑定只读邮箱身份和工具可用性。触发提醒时，插件通过原版 CLI 的临时会话直接调用 Gmail 发信，内容仅含额度和时间信息。投递前失败会退避重试，发信结果不确定时在托盘“查看额度”中显示待核对。

```powershell
node "$env:LOCALAPPDATA/CodexQuotaGuard/app/scripts/connect-gmail.mjs"
```

如需将两类提醒都发往另一个邮箱，可用 `--recipient` 指定唯一收件人。将示例地址替换为自己的收件邮箱。

```powershell
node "$env:LOCALAPPDATA/CodexQuotaGuard/app/scripts/connect-gmail.mjs" --recipient "recipient@example.com"
```

同一 Gmail 账号再次无参绑定时会保留收件地址。切换 Gmail 账号后无参绑定会以新账号自身为收件人。

## 一键回退与恢复

双击源码或安装目录中的 **`rollback.cmd`**：关闭自动控制，保留插件、监控及待恢复队列；如有专用入口记录的桌面，则核对 PID、完整程序路径和启动时间后关闭它，再用普通环境重新打开。重启会结束该会话中尚在执行的工作；不要在需要保留运行进程时使用重启选项。PID 已复用或记录不符时拒绝结束其他进程。

只退出自动控制、不重启桌面：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback.ps1
```

后台崩溃时，回退脚本仍可离线关闭自动控制，保留原队列；账本损坏则保留原文件并报告，不覆盖数据。若会话桥接本身崩溃，普通 Codex 入口始终可用，可使用一键回退重新打开已记录的桌面。**无法在已经断开的 stdio 会话中无损替换进程**，不能声称所有桥接崩溃均透明恢复。之后重新运行独立监控和专用启动入口即可恢复守卫，无需重新安装或永久禁用插件。

## 迁移、安全与工具

唯一持久启动变量写入点是 `scripts/migration.ps1` 的旧值修复：只有当前值精确指向本插件已确认的旧桥接路径，才恢复可信备份或清除；写入前再次核对。未设置的值不复活，其他路径不覆盖，系统级不套用用户级备份。无 `setx`、直接注册表启动覆盖或计划任务安装。

不删除或重写 Codex 凭据、会话、项目和其他插件配置。旧 `state.json` 原样保留，不自动执行旧任务；新队列存入 `automation-state.json`。后者包含待恢复请求正文，和本插件令牌一起存于限制访问的插件数据目录。

MCP 工具：`guard_status`、`guard_check_now`、`guard_enable`、`guard_disable`、`guard_configure`、`guard_automation_status`、`guard_safe_mode`、`guard_cancel_pending`。启用工具只作用于现有连接，不能把普通桌面变成守卫会话。MCP 初始化与工具发现离线可用，不启动查询后台。

运行诊断命令时，请将 `C:\path\to\codex.exe` 替换为本机原版 Codex CLI 的路径。

```powershell
npm run check
npm run build
npm test
node .\scripts\doctor.mjs --backend "C:\path\to\codex.exe"
```

需要卸载时，单独运行以下命令。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载停止本插件监控、移除自己的自启动项并修复旧覆盖，保留数据；显式 `-RemovePlugin` 才取消本插件注册。守卫会话中卸载后请求仍直通，需正常关闭会话后再删除其运行文件。验证范围与未验证行为见 [修复验证记录](docs/repair-validation.md)。
