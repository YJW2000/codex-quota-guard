using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class MonitorUI {
    static Dictionary<string,object> config;
    static string Read(string key){return (string)config[key];}
    static string Quote(string value){return "\""+value.Replace("\"","\\\"")+"\"";}
    static async Task<string> Control(string command){
        var info=new ProcessStartInfo(Read("nodePath"),Quote(Path.Combine(Read("root"),"src","main.mjs"))+" "+command);
        info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
        info.StandardOutputEncoding=System.Text.Encoding.UTF8;info.StandardErrorEncoding=System.Text.Encoding.UTF8;
        info.EnvironmentVariables["CODEX_QUOTA_GUARD_HOME"]=Read("stateDir");
        using(var child=Process.Start(info)){
            var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();
            if(!await Task.Run(()=>child.WaitForExit(5000))){child.Kill();throw new Exception("暂不可用");}
            if(child.ExitCode!=0)throw new Exception("暂不可用");return await output;
        }
    }
    [STAThread] static int Main(string[] args){
        if(args.Length==1 && args[0]=="--close-tray"){
            try{using(var e=EventWaitHandle.OpenExisting("Local\\CodexQuotaMonitorExit"))e.Set();}catch(WaitHandleCannotBeOpenedException){}return 0;
        }
        if(args.Length!=1 || (args[0]!="--tray" && args[0]!="--validate"))return 2;
        try{
            string root=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,".."));
            config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"installation.json")));
            if(Read("mode")!="independent-monitor")return 2;
            if(args[0]=="--validate")return 0;
            try{Control("start").GetAwaiter().GetResult();}catch{}
            bool first;using(var mutex=new Mutex(true,"Local\\CodexQuotaMonitorTray",out first)){
                if(!first)return 0;Application.EnableVisualStyles();Application.Run(new Tray());
            }return 0;
        }catch{if(args[0]=="--tray")MessageBox.Show("额度监控暂不可用。Codex 可正常使用。","额度监控");return 1;}
    }
    sealed class Tray:ApplicationContext{
        NotifyIcon icon;System.Windows.Forms.Timer timer;bool polling;
        ToolStripMenuItem state=new ToolStripMenuItem("暂不可用");
        EventWaitHandle stop=new EventWaitHandle(false,EventResetMode.ManualReset,"Local\\CodexQuotaMonitorExit");
        public Tray(){
            stop.Reset();icon=new NotifyIcon{Icon=SystemIcons.Information,Text="Codex 额度监控",Visible=true};
            var menu=new ContextMenuStrip();state.Enabled=false;menu.Items.Add(state);
            Add(menu,"查看额度",async()=>await ShowStatus());Add(menu,"立即查询",async()=>{await Control("check");await Refresh();});
            Add(menu,"查看自动控制",async()=>await ShowAutomation());
            Add(menu,"安全模式（保留监控）",async()=>{await Control("guard.safeMode");await Refresh();});
            Add(menu,"启用已连接引擎的守卫",async()=>{await Control("enable");await Refresh();});
            Add(menu,"退出监控",async()=>{try{await Control("shutdown");}finally{ExitThread();}});
            icon.ContextMenuStrip=menu;icon.DoubleClick+=async delegate{await ShowStatus();};
            timer=new System.Windows.Forms.Timer{Interval=3000};timer.Tick+=async delegate{if(stop.WaitOne(0)){ExitThread();return;}await Refresh();};timer.Start();
        }
        void Add(ContextMenuStrip menu,string text,Func<Task> action){var item=new ToolStripMenuItem(text);item.Click+=async delegate{try{await action();}catch{state.Text="暂不可用";}};menu.Items.Add(item);}
        async Task Refresh(){if(polling)return;polling=true;try{var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await Control("status"));state.Text=(string)data["label"];}catch{state.Text="暂不可用";}finally{polling=false;}}
        async Task ShowStatus(){
            string text="暂不可用";
            try{
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await Control("status"));text=(string)data["label"];
                foreach(Dictionary<string,object> row in (IEnumerable)data["windows"]) text+="\r\n"+row["limitId"]+" / "+row["name"]+"：剩余 "+row["remainingPercent"]+"%";
            }catch{}MessageBox.Show(text,"额度监控");
        }
        async Task ShowAutomation(){
            string text="暂不可用";
            try{
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await Control("guard.status"));
                if(data.ContainsKey("bridges")){
                    int count=0;foreach(object item in (IEnumerable)data["bridges"])count++;
                    text="已连接引擎："+count+"\r\n待恢复任务："+data["pendingCount"];
                    text+="\r\n自动控制："+((bool)data["enabled"]?"已启用":"安全模式");
                    if(count==0)text+="\r\n当前只有独立监控；自动停跑需要使用专用会话启动脚本。";
                    foreach(Dictionary<string,object> row in (IEnumerable)data["jobs"])text+="\r\n"+row["threadId"]+" / "+row["state"];
                }
            }catch{}MessageBox.Show(text,"额度守卫");
        }
        protected override void ExitThreadCore(){timer.Stop();timer.Dispose();stop.Dispose();icon.Visible=false;icon.Dispose();base.ExitThreadCore();}
    }
}
