# Codex 额度守卫 0.2 — 独立只读监控

此版本移除 0.1 的桌面启动接管。**不会设置用户级或系统级 CODEX_CLI_PATH，不代理桌面通信，不自动暂停、恢复或启动任务。**

监控单独运行：Node 后台启动一个独立的原版 Codex CLI `app-server` 子进程，只发送 `initialize` 与 `account/rateLimits/read`。它不连接或接管桌面端的引擎，不发起模型请求。后台通过本机命名管道为可选 MCP 工具和独立 Windows 托盘提供状态。

连接失败、超时、进程退出、数据缺失或过期统一显示 **暂不可用**，清空当前额度展示。旧值不会被当成新数据；不会提供推算或虚构额度。额度低于阈值只提示，不控制 Codex。

## 旧版故障和迁移

旧版 `scripts/install.ps1` 写入用户级启动覆盖，`scripts/start-codex.ps1` 也曾设置进程级覆盖。桥接对版本、配置和通信错误的拒绝启动会影响整个桌面启动链路。用户已通过删除覆盖并重启系统验证启动恢复；本仓库未证实组织设置错误的具体内部原因。

新版安装与卸载都会调用 `scripts/migration.ps1`：

- 只有当前值规范化后精确等于本插件安装根目录下的 `dist/codex-quota-bridge.exe`，或默认安装目录下该路径，才允许修改。
- 用户级原值有可信旧备份时恢复原字符串；无备份、备份为空或仍指向旧桥接时删除该覆盖。
- 系统级没有旧备份，不使用用户级备份替代；只清理精确匹配的旧插件覆盖，权限不足则明确报错。
- 未设置的变量保持未设置；其他路径（即使文件也叫 codex-quota-bridge.exe）保持原样。写入前重新核对当前值。
- 不改写登录凭据、会话、项目或其他插件配置。旧 `state.json` 队列原样保留，永不自动执行。

不需要退出登录，不需要清理 Codex 数据。旧启动脚本成为无操作提示，不再打开或包裹 Codex。

## 安装修复文件与重新启用

要求 Windows、Node.js 22+、系统 .NET Framework 4.x。修复后从源码目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

默认只更新本插件文件、修复精确匹配的旧覆盖，不启动后台，不启用开机启动，不改动插件注册状态。安装不要求额度服务在线；没有 CLI 时也能安装，监控显示暂不可用。

然后按需启动独立监控：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-monitor.ps1
```

如果需要在 Codex 中重新注册本插件 MCP 工具，显式加 `-RegisterPlugin` 运行安装脚本。只注册本插件自己的 marketplace 和插件，不把任何服务器设为 required。可在 Codex 的插件设置中按需启用；独立托盘不依赖 MCP。

可选 `-AutoStart` 仅创建指向 `codex-quota-monitor.exe --tray` 的用户 Startup 快捷方式；不会启动 Codex，不设置启动覆盖。不开启此选项则不新增自启动。

## 工具与退出

`guard_status` / `guard_check_now` 只读状态与额度，`guard_enable` / `guard_disable` 只切换独立轮询，`guard_configure` 只设置提醒阈值。MCP 初始化和工具发现不启动后台，也不查询账号。监控未运行时返回暂不可用。

```powershell
node .\src\main.mjs status
node .\src\main.mjs check
node .\src\main.mjs shutdown
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载只停止监控、移除精确匹配的本插件自启动项并修复遗留覆盖，保留运行数据。需要取消本插件注册时显式使用 `-RemovePlugin`。不会按进程名称结束 Codex 或重写全局配置文件。

## 验证

```powershell
npm run check
npm run build
npm test
node .\scripts\doctor.mjs --backend <原版codex.exe路径>
```

测试覆盖安装、更新、卸载、自启动目标、旧覆盖迁移、其他环境变量与 Codex 数据样本不变、只读请求白名单、连接失败/超时/崩溃、数据过期和 MCP 离线降级。桌面替身进程的隔离测试不等于真实桌面 GUI 启动/登录测试。实际执行结果和未验证项见 `docs/repair-validation.md`。
