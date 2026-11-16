using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Launcher {
    [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct StartupInfo {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort showWindow, reservedSize; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    private const uint Continuous = 0x80000000;
    private const uint SystemRequired = 0x00000001;
    private static Dictionary<string, object> config;
    private static string Read(string key) { return (string)config[key]; }
    internal static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1).Append(ch);
            else result.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static string Join(IEnumerable<string> args) { List<string> result = new List<string>(); foreach (string arg in args) result.Add(Quote(arg)); return String.Join(" ", result); }
    private static ProcessStartInfo StartInfo(string exe, IEnumerable<string> args) {
        ProcessStartInfo info = new ProcessStartInfo(exe, Join(args));
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.EnvironmentVariables["CODEX_QUOTA_GUARD_HOME"] = Read("stateDir");
        return info;
    }
    private static ProcessStartInfo NodeInfo(string command) {
        var args = new List<string>(new string[] {Path.Combine(Read("root"), "src", "main.mjs"), command});
        if (command == "status") args.Add("--no-start");
        return StartInfo(Read("nodePath"), args);
    }
    private static int RunInherited(ProcessStartInfo start) {
        IntPtr current = GetCurrentProcess(); IntPtr[] handles = new IntPtr[3];
        IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero; bool initialized = false;
        try {
            for (int i = 0; i < 3; i++) {
                IntPtr original = GetStdHandle(-10 - i);
                if (!DuplicateHandle(current, original, current, out handles[i], 0, true, 2))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                // Exclude the original handles: otherwise Node cannot identify
                // the extra inherited copies and background workers keep pipes open.
                if (!SetHandleInformation(original, 1, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            initialized = true; handleList = Marshal.AllocHGlobal(3 * IntPtr.Size);
            for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, handles[i]);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            StartupInfoEx startup = new StartupInfoEx(); startup.info.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.info.flags = 0x100; startup.info.stdin = handles[0]; startup.info.stdout = handles[1]; startup.info.stderr = handles[2]; startup.attributes = attributes;
            Environment.SetEnvironmentVariable("CODEX_QUOTA_GUARD_HOME", Read("stateDir"));
            ProcessInfo child;
            if (!CreateProcess(start.FileName, new StringBuilder(Quote(start.FileName) + " " + start.Arguments), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out child))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try { WaitForSingleObject(child.process, 0xffffffff); uint code; if (!GetExitCodeProcess(child.process, out code)) return 1; return unchecked((int)code); }
            finally { CloseHandle(child.thread); CloseHandle(child.process); }
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    private static string Control(string command) {
        ProcessStartInfo info = NodeInfo(command); info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        using (Process p = Process.Start(info)) {
            Task<string> text = p.StandardOutput.ReadToEndAsync(); Task<string> error = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15000)) { p.Kill(); throw new Exception("后台响应超时"); }
            if (p.ExitCode != 0) throw new Exception(error.Result);
            return text.Result;
        }
    }
    [STAThread] private static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--close-tray") {
                try { using (var stop = EventWaitHandle.OpenExisting("Local\\CodexQuotaGuardTrayExit")) stop.Set(); }
                catch (WaitHandleCannotBeOpenedException) {}
                return 0;
            }
            if (args.Length == 1 && args[0] == "--power") {
                if (SetThreadExecutionState(Continuous | SystemRequired) == 0) return 1;
                try { while (Console.OpenStandardInput().ReadByte() != -1) {} }
                finally { SetThreadExecutionState(Continuous); }
                return 0;
            }
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
            config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "installation.json")));
            if (args.Length == 1 && args[0] == "--tray") {
                bool first; using (Mutex mutex = new Mutex(true, "Local\\CodexQuotaGuardTray", out first)) {
                    if (!first) return 0;
                    Application.EnableVisualStyles(); Application.Run(new GuardTray());
                }
                return 0;
            }
            bool bridge = Array.IndexOf(args, "app-server") >= 0 && Array.IndexOf(args, "generate-json-schema") < 0 && Array.IndexOf(args, "generate-ts") < 0 && Array.IndexOf(args, "daemon") < 0 && Array.IndexOf(args, "proxy") < 0;
            ProcessStartInfo start;
            if (bridge) {
                List<string> forwarded = new List<string>(new string[] {Path.Combine(Read("root"), "src", "main.mjs"), "bridge", "--"}); forwarded.AddRange(args);
                start = StartInfo(Read("nodePath"), forwarded);
            } else start = StartInfo(Read("backendPath"), args);
            // Duplicate the existing standard handles into the child explicitly;
            // no console text buffering or second RPC framing layer is involved.
            return RunInherited(start);
        } catch (Exception e) { Console.Error.WriteLine("[quota-guard] " + e.Message); return 1; }
    }
    private sealed class GuardTray : ApplicationContext {
        private NotifyIcon icon; private System.Windows.Forms.Timer timer; private bool polling;
        private ToolStripMenuItem state = new ToolStripMenuItem("正在连接额度守卫…");
        private EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, "Local\\CodexQuotaGuardTrayExit");
        internal GuardTray() {
            stop.Reset();
            icon = new NotifyIcon(); icon.Icon = SystemIcons.Shield; icon.Text = "Codex 额度守卫"; icon.Visible = true;
            ContextMenuStrip menu = new ContextMenuStrip(); state.Enabled = false; menu.Items.Add(state);
            Add(menu, "查看额度和待恢复任务", delegate { ShowStatus(); });
            Add(menu, "立即检查", delegate { Run("check"); });
            Add(menu, "启用守卫", delegate { Run("enable"); });
            Add(menu, "关闭守卫（保留队列）", delegate { Run("disable"); });
            Add(menu, "关闭托盘图标", delegate { ExitThread(); });
            icon.ContextMenuStrip = menu; icon.DoubleClick += delegate { ShowStatus(); };
            timer = new System.Windows.Forms.Timer(); timer.Interval = 3000; timer.Tick += async delegate {
                if (stop.WaitOne(0)) { ExitThread(); return; }
                if (polling) return; polling = true;
                try {
                    string text = await Task.Run(() => Control("status"));
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                    state.Text = ((bool)data["enabled"] ? "守卫已启用" : "守卫已关闭") + "；等待任务 " + data["pendingCount"];
                } catch { state.Text = "守卫连接异常，请打开状态页检查"; }
                finally { polling = false; }
            }; timer.Start();
        }
        private void Add(ContextMenuStrip menu, string title, Action action) { var item = new ToolStripMenuItem(title); item.Click += delegate { action(); }; menu.Items.Add(item); }
        private async void Run(string command) { try { await Task.Run(() => Control(command)); } catch (Exception e) { MessageBox.Show(e.Message, "额度守卫"); } }
        private async void ShowStatus() {
            string status;
            try { status = await Task.Run(() => Control("status")); } catch (Exception e) { status = e.Message; }
            Form form = new Form(); form.Text = "Codex 额度守卫 — 状态与待恢复队列"; form.Size = new Size(820, 620);
            TextBox box = new TextBox(); box.Multiline = true; box.ReadOnly = true; box.ScrollBars = ScrollBars.Both; box.Dock = DockStyle.Fill; box.Font = new Font("Consolas", 10); box.Text = status.Replace("\n", "\r\n");
            form.Controls.Add(box); form.Show();
        }
        protected override void ExitThreadCore() { timer.Stop(); timer.Dispose(); stop.Dispose(); icon.Visible = false; icon.Dispose(); base.ExitThreadCore(); }
    }
}
