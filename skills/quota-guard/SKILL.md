---
name: quota-guard
description: 查看独立 Codex 额度监控状态、真实额度或修改提醒阈值时使用。
---

# 独立额度监控

使用 guard_status 或 guard_check_now 查看真实额度。失败、过期或后台未运行时说明“暂不可用”，不能猜测剩余量。

guard_enable / guard_disable 仅切换独立轮询；guard_configure 仅修改提醒阈值。后台通过 start-monitor.ps1 单独启动，不要求桌面重启。

此版本不接管 Codex 启动、不自动停跑/续跑任务。禁止建议设置 CODEX_CLI_PATH、运行旧桥接或旧缓存里的安装脚本。需要修复旧覆盖时使用新源码的 migration.ps1 / install.ps1，只处理精确匹配本插件的值。不要清理凭据、会话、项目和其他插件配置。
