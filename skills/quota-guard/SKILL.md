---
name: quota-guard
description: 查看或管理 Codex 真实额度、自动暂停续跑、待恢复队列、预留阈值及安全回退时使用。
---

# Codex 额度守卫

使用 guard_status / guard_check_now 查看真实额度。失败、过期或未运行时报告“暂不可用”，不能猜测、推算或编造剩余量。

独立监控不控制桌面任务。自动暂停和恢复只覆盖经修复版 start-guarded-codex.ps1 预检启动并连接的引擎。使用 guard_automation_status 核实连接数量和任务状态；没有连接时明确说明当前只有监控，不声称已保护全部任务。

按服务返回的时长识别 5 小时和周窗口。只有 5 小时额度低才暂停，确认暂停或暂缓后发 Gmail；周额度低只发提醒。5 小时窗口缺失时允许新任务正常执行。guard_status 的 notifications 显示实际投递状态。

两类提醒都由绑定的 Gmail 发往同一个收件邮箱。用户明确指定今后的收件地址时，用已安装的 `scripts/connect-gmail.mjs --recipient <邮箱>` 配置并核对返回的发件人和收件人。仅发送一次测试邮件时保留现有绑定。

guard_enable / guard_disable 启用或关闭轮询与现有连接的自动控制；guard_configure 设置预留阈值、防睡眠；guard_cancel_pending 取消指定挂起项。guard_safe_mode 仅退出自动控制，保留监控和队列。审批与派发结果不确定的任务仍需用户处理，不绕过批准或自动重试未知结果。

重新启用先从修复源码安装，启动 start-monitor.ps1。需要完整守卫时先让用户保存工作并正常退出桌面，再运行 start-guarded-codex.ps1；不得擅自结束正在使用的桌面。该入口只对新子进程设置临时环境。禁止设置用户级/系统级 CODEX_CLI_PATH，禁止运行 0.1 旧缓存的安装脚本。旧覆盖只用 migration.ps1 按明确所有权清理/恢复，不覆盖用户其他路径。

rollback.ps1 保留插件和监控，离线也可关闭自动控制；rollback.cmd 还会核对并重启专用入口记录的桌面，可能中断正在执行的工作。不要清理登录凭据、会话、项目或其他插件配置。真实 GUI 登录尚未验证，预检通过不能替代该验证。
