# Codex Quota Guard 0.4.1

[简体中文](../README.md) · [繁體中文](README.zh-Hant.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[Download the Windows installer (v0.4.1)](https://github.com/YJW2000/codex-quota-guard/releases/download/v0.4.1/codex-quota-guard-v0.4.1-windows.zip)

Codex Quota Guard monitors the quota reported by Codex. In a guarded session it can pause chats when the five-hour allowance runs low, queue new requests, and resume work after the allowance recovers. It can also keep Windows awake while work is queued. The monitor runs independently of desktop startup and sign-in. It requires no user- or machine-level `CODEX_CLI_PATH` override.

## Startup issue in version 0.1

During startup, Codex Desktop calls `app-server --print-startup-config --startup-client-info ...` with standard input set to `ignore`. The 0.1 native launcher treated that one-shot command as a long-running RPC session. The Node.js bridge closed the session at the end of standard input, then tried to forward the configuration output through the closed connection. The bridge also stopped forwarding on the child process’s `exit` event, before `close` signaled that its output streams had drained.

A local comparison reproduced the failure. The original CLI exited successfully and returned **122 bytes of valid JSON**. The 0.1 bridge also exited successfully but returned **0 bytes**. The repaired bridge returned the same **122 bytes of valid JSON** as the original CLI. This verifies the configuration exchange used during startup. Organization settings and sign-in in the actual desktop UI still need a separate regression test.

## Monitoring and guarded sessions

**Standalone monitoring.** The monitor starts a separate, read-only `app-server` using the original CLI, initializes it, and calls `account/rateLimits/read`. The tray application and optional MCP tools read the result over a local pipe authenticated with a token. Missing or stale data, timeouts, and monitor failures appear as `暂不可用` (“temporarily unavailable”).

**Automatic pause and resume.** The Windows desktop version tested here communicates with its engine over private standard I/O. To control chats, use the guarded launcher. It checks the startup configuration and protocol, then sets the environment for the new desktop process only. The standard shortcut, user and machine environment, and existing desktop processes keep their normal behavior.

- The default reserve is 5%. When the service reports that the five-hour window (300 minutes) has reached or fallen below the reserve, the guard saves a continuation record and interrupts active turns in all loaded chats on connected engines, including visible subtasks.
- New requests are saved with their original parameters and deduplicated by client ID. They become eligible for replay once queueing is acknowledged. A lost response or timeout leaves an unconfirmed request ineligible for automatic replay.
- When the five-hour allowance rises above the reserve and the account can use it, the next quota check or notification triggers a continuation in the original chat. The default polling interval is 30 seconds and the bridge retries its connection every second. A predicted reset time alone cannot trigger a continuation.
- Requests are dispatched in order within each chat. Different chats can resume in parallel. The guard skips canceled or archived work and turns that have since moved on. Approvals and requests for user input stay with the user. An uncertain dispatch is flagged for manual review.
- When the quota is unknown or monitoring fails, normal requests go straight to the original engine and automatic pause and resume are suspended. The bridge reconnects when the service recovers. The optional request to keep Windows awake while work is queued is released when the service exits.
- Automation covers engines connected through the guarded launcher. Other Codex instances, terminals, and devices run independently. Resumption can be delayed while Windows is asleep, the network is offline, or the application is closed.

## Install and enable

**Install from the Windows download.** You need Node.js 22 or later and .NET Framework 4.x. Extract the ZIP and double-click `install.cmd` to install and start standalone monitoring. Use the guarded launcher below to enable automatic pause and resume.

Requirements are Windows, Node.js 22 or later, and .NET Framework 4.x. Run these commands from the **repaired source checkout**. Old cached installers contain the earlier startup behavior.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-monitor.ps1
```

The installer checks the source, runs the tests, builds the executables, and updates the plugin. If the original CLI is unavailable, the monitor shows `暂不可用`. An active bridge blocks replacement of its executable. Close the old guarded session or tray normally before retrying the update. The installer never terminates Codex by process name. It stops the plugin’s monitor and tray during an update, so run `start-monitor.ps1` afterward.

To enable automatic pause and resume, save your work and **fully exit Codex normally**. Then run the following command in an external PowerShell window.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-guarded-codex.ps1
```

The launcher resolves the desktop executable from the Windows app manifest. Its read-only preflight compares the original and bridged one-shot startup responses and checks initialization, `configRequirements/read`, and `config/read`. If preflight fails, the launcher uses the ordinary desktop entry point and keeps independent monitoring available. After launch it waits for an engine handshake matching this session ID. A timeout reports that the connection could not be confirmed. In the tray, open **查看自动控制** (“View automatic control”) to check the connected engine count. Zero means only monitoring is active. Desktop sign-in still requires a separate UI check.

To restore the Codex MCP tools, run `install.ps1 -RegisterPlugin` and enable the plugin in Codex settings. Registration applies only to this plugin and its marketplace. The MCP server is optional for both monitoring and the session bridge. `-AutoStart` adds the monitor tray shortcut to Windows Startup. Codex itself starts separately.

## Email alerts

The guard sends both kinds of alert from the connected Gmail account to one recipient. The initial default is the Gmail account itself. A confirmed interruption or deferred request triggers a five-hour alert. Multiple affected chats on the same account share one alert per low-quota episode. When standalone monitoring sees the weekly window (10,080 minutes) reach the threshold, it sends a weekly alert even if no desktop engine is connected. Chats can keep using the remaining weekly allowance. If the service reports only the weekly window, the five-hour status is unavailable.

After installation, run the following command to verify and bind the Gmail account. Binding checks the account identity and tool availability. To send an alert, the plugin uses a temporary session on the original CLI to call Gmail directly. Alerts contain quota and timing information. Failures before submission are retried with backoff. An uncertain send is flagged for review in **查看额度** (“View quota”).

```powershell
node "$env:LOCALAPPDATA/CodexQuotaGuard/app/scripts/connect-gmail.mjs"
```

To deliver both kinds of alert to another address, use `--recipient` and replace the example with your intended recipient.

```powershell
node "$env:LOCALAPPDATA/CodexQuotaGuard/app/scripts/connect-gmail.mjs" --recipient "recipient@example.com"
```

Rebinding the same Gmail account without arguments preserves its recipient. Binding a different Gmail account without arguments sets the recipient to that new account.

## Rollback and recovery

Double-click **`rollback.cmd`** in the source or installation directory to disable automatic control and keep the plugin, monitor, and queue. If there is a recorded guarded desktop, the script checks its PID, full executable path, and start time before closing it and reopening it with the ordinary environment. A reused PID or mismatching record prevents termination. Restarting ends any work still running in that session.

To turn off automatic control while keeping your current desktop and tasks running, use this command.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback.ps1
```

If the background service crashes, the rollback script can disable automation offline and preserve the queue. It reports a damaged ledger and leaves the original file intact. If the bridge itself crashes, the standard Codex entry point remains available. `rollback.cmd` can reopen the recorded desktop, but a lost standard I/O connection requires a new session. To re-enable the guard, start the independent monitor and launch a new guarded desktop.

## Migration, data, and tools

`scripts/migration.ps1` handles the only persistent writes to the legacy launch variable. It rechecks that the current value points exactly to a known bridge owned by this plugin before restoring a trusted backup or clearing the override. An absent variable stays absent, unrelated paths are preserved, and a user backup is only used at user scope. Installation uses no `setx` command, direct registry launch override, or scheduled task.

Codex credentials, sessions, projects, and other plugin settings stay intact. The legacy `state.json` is preserved and its jobs are never replayed automatically. The new queue is stored in `automation-state.json`. This file contains pending request bodies and is kept with the plugin token in the access-restricted plugin data directory.

The MCP tools are `guard_status`, `guard_check_now`, `guard_enable`, `guard_disable`, `guard_configure`, `guard_automation_status`, `guard_safe_mode`, and `guard_cancel_pending`. Enabling automation applies to existing connections. A regular desktop instance needs a new launch through the guarded entry point to participate. MCP initialization and tool discovery work offline without starting the quota reader.

For the diagnostic command below, replace `C:\path\to\codex.exe` with the path to the original Codex CLI.

```powershell
npm run check
npm run build
npm test
node .\scripts\doctor.mjs --backend "C:\path\to\codex.exe"
```

To uninstall the plugin, run this command separately.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

Uninstalling stops the plugin monitor, removes its own startup entry, repairs the legacy override, and preserves plugin data. Pass `-RemovePlugin` to also remove the plugin registration. Requests in an open guarded session continue to pass through. Close that session normally before deleting its running files. The [repair validation notes (Simplified Chinese)](repair-validation.md) describe what was tested and what remains unverified.
