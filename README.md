# Codex 额度守卫

Windows 本地插件。监控当前账号的 Codex 订阅额度，在剩余 **5%** 时中断本机桌面版任务，等待真实额度恢复，再在原聊天继续执行。监控、等待和调度均不调用模型。

## 工作方式

```text
Codex Desktop ↔ Windows 启动器 ↔ 透明通信桥 ↔ 原版 Codex 引擎
                                   ↕
                         本机额度控制器／持久化队列
                                   ↕
                            MCP 工具与 Windows 托盘
```

- 检查 5 小时、周额度及接口返回的其他非空额度窗口；任一窗口剩余不超过预留值即暂停。
- 平时 30 秒检查一次，剩余不超过 15% 时每 5 秒检查；收到额度事件及到重置时间立即重新检查。
- 使用 `ordinaryUsageAllowed` 与真实剩余额度共同判断恢复。空值不代表可用；周额度仍不足时不会因短窗口重置而开跑。
- 暂停前落盘恢复记录，拦住新的轮次开始请求。不同聊天并发恢复，同一聊天顺序执行。
- 已完成、人工取消、归档或等待审批的任务不擅自启动。派发结果无法确认时标记 `attention`，避免重复执行。
- 等待恢复期间用 Windows 临时电源请求防睡眠，允许屏幕关闭；关闭守卫或队列清空即释放。

## 要求与安装

Windows 10/11、Node.js 22 或更新版本、系统 .NET Framework 4.x，以及已登录的 Codex 桌面版。无需 OpenAI API Key，无第三方 npm 运行依赖。

先完成当前工作并保留聊天，然后在项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本执行源码检查、测试、原生启动器构建与当前引擎兼容检查，再安装本地插件并设置用户级 `CODEX_CLI_PATH`。备份原设置，保存运行数据到 `%LOCALAPPDATA%\CodexQuotaGuard`，仅当前 Windows 用户和 SYSTEM 可访问。

**完全退出并重新打开 Codex 才能接管原来已经启动的桌面进程。** 安装本身不能改接现有进程的 stdio。也可以退出后运行安装目录内的 `scripts\start-codex.ps1`。不要把“插件已安装”当作“当前会话已受保护”。

本项目使用当前 Windows 桌面版具备的 `CODEX_CLI_PATH` 入口和 App Server 协议，属于需要持续验证的本机集成。引擎版本改变后桥接拒绝启动，请重新运行安装脚本。安装不会修改 Codex 程序包、账号令牌或权限策略。

## 使用

托盘菜单可查看额度、检查恢复、启停守卫。MCP 提供：

| 工具 | 功能 |
| --- | --- |
| `guard_status` | 额度窗口、已连接引擎、待恢复队列与错误 |
| `guard_check_now` | 立即读取真实额度并处理暂停／恢复 |
| `guard_enable` / `guard_disable` | 启停保护；关闭时保留队列并释放防睡眠 |
| `guard_configure` | 设置 `reservePercent`（1–50）或 `preventSleep` |
| `guard_cancel_pending` | 用队列记录的 `id` 取消待恢复任务 |

直接使用后台命令也不需要模型：

```powershell
node .\src\main.mjs status
node .\src\main.mjs check
node .\src\main.mjs configure '{"reservePercent":5,"preventSleep":true}'
node .\src\main.mjs cancel <队列记录ID>
```

状态中至少应有一个 `ready: true` 的桥接实例及 `running` 或 `paused` 的真实账号额度状态。`bridges: []` 表示没有已接管的桌面引擎；`unknown` 表示读取尚未确认，此时不派发新任务。`attention` 项请打开原聊天核对，必要时取消记录后手动继续。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

恢复安装前的启动设置并移除本地插件，随后重启 Codex。保留恢复记录与安装文件供检查，不递归删除个人数据。

## 验证与开发

```powershell
npm run check
npm test
npm run build
node .\scripts\doctor.mjs --backend <原版codex.exe路径>
```

测试使用独立模拟引擎、临时状态目录和真实 stdio／本机管道，覆盖阈值、周额度、多个项目与子任务、排队、进度保存、人工取消、账号切换及不确定派发。`doctor` 仅握手和读取额度，不创建任务、不兑换额度。GitHub Actions 在 Windows 上执行检查、测试和原生构建。

## 限制与数据

- 只接管经桥接启动的本机 Codex 桌面引擎。独立 CLI、其他设备及云端任务不受其停止控制，但可能消耗同一账号额度。
- 额度存在统计延迟，单次请求可能消耗超过预留的 5%。无法承诺绝不耗尽；在途请求和已经提交的外部操作不能撤回。
- 读取失败会关闭派发入口并尝试中断已知任务；后台异常时桥接重连，失败则拒绝新的执行请求。强制终止 Windows、磁盘损坏或网络故障期间不能保证即时恢复。
- 自动恢复是新轮次，保留原聊天与配置，不是恢复进程内存；恢复提示要求先核对已完成操作。
- 取消托盘图标不等于停用守卫。选择“关闭守卫”才停止接管并释放电源请求。
- 仅在本机保存账号标识、请求内容及恢复状态，不读取／复制登录令牌。通过当前用户私有管道和随机令牌控制后台，不暴露 HTTP 监听端口，不上传遥测。
- 不自动兑换重置券、购买额度、切换账号或模型，也不替原任务批准权限。

源码公开不等于插件已提交 OpenAI 公共目录；本仓库提供本机安装方式。
