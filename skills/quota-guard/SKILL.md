---
name: quota-guard
description: 查看或管理本机 Codex 额度守卫、暂停队列、自动恢复和预留额度设置时使用。
---

# Codex 额度守卫

使用本插件的 MCP 工具读取真实状态。不要靠模型循环检查、定时发消息或新建自动化代替后台组件。

- `guard_status`：查看连接、额度窗口、排队任务及错误。
- `guard_check_now`：立即检查并按现有配置处理。
- `guard_enable` / `guard_disable`：启停守卫；关闭时保留队列，不擅自执行。
- `guard_configure`：调整 `reservePercent`（默认 5）与 `preventSleep`（默认 true）。
- `guard_cancel_pending`：使用状态返回的任务 id 取消待恢复记录。

没有连接的本机桥接实例时，应说明守卫尚未保护当前桌面版会话，参照 README 安装后重启 Codex；不能声称已全局生效。

恢复需要实际额度和账号权限均确认。不要兑换重置券、购买额度、切换账号、改变模型或批准原任务的权限请求。`attention` 项需要用户检查原聊天，不能盲目重放。
