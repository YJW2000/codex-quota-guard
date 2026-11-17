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

    [STAThread] private static int Main(string[] args) {
        string backend=Environment.GetEnvironmentVariable("CODEX_QUOTA_REAL_CLI");
        try {
            string root=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,".."));
            try {config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"installation.json")));}
            catch {config=new Dictionary<string,object>();}
            if(config==null)config=new Dictionary<string,object>();
            if(String.IsNullOrEmpty(backend)&&config.ContainsKey("backendPath"))backend=Read("backendPath");
            if(String.IsNullOrEmpty(backend)||!File.Exists(backend)||String.Equals(backend,System.Reflection.Assembly.GetExecutingAssembly().Location,StringComparison.OrdinalIgnoreCase))return 2;
            if(!config.ContainsKey("stateDir"))config["stateDir"]=Environment.GetEnvironmentVariable("CODEX_QUOTA_GUARD_HOME")??Path.Combine(root,"data");
            if(args.Length==1&&args[0]=="--power") {
                SetThreadExecutionState(Continuous|SystemRequired);
                try{while(Console.OpenStandardInput().ReadByte()!=-1){}}finally{SetThreadExecutionState(Continuous);}return 0;
            }
            bool interactive=Array.IndexOf(args,"app-server")>=0;
            foreach(string flag in new string[]{"--print-startup-config","--startup-sign-out","--help","-h","--version","-V","daemon","proxy","generate-ts","generate-json-schema"})if(Array.IndexOf(args,flag)>=0)interactive=false;
            // Organization settings use stdin=ignore and a single JSON response.
            // They must never enter the long-lived JSON-RPC/EOF lifecycle.
            if(!interactive)return RunInherited(StartInfo(backend,args));
            string node=config.ContainsKey("nodePath")?Read("nodePath"):null;
            string script=Path.Combine(root,"src","main.mjs");
            if(String.IsNullOrEmpty(node)||!File.Exists(node)||!File.Exists(script))return RunInherited(StartInfo(backend,args));
            var forwarded=new List<string>(new string[]{script,"bridge","--"});forwarded.AddRange(args);
            Environment.SetEnvironmentVariable("CODEX_QUOTA_REAL_CLI",backend);
            return RunInherited(StartInfo(node,forwarded));
        }catch(Exception e){
            Console.Error.WriteLine("[quota-guard] bridge startup fallback: "+e.GetType().Name);
            if(!String.IsNullOrEmpty(backend)&&File.Exists(backend))try{return RunInherited(StartInfo(backend,args));}catch{}
            return 1;
        }
    }
}
