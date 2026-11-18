using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
class NativeEngine {
 static int Main(string[] args) {
  Console.InputEncoding=new System.Text.UTF8Encoding(false);
  Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  if(args.Length==0){
   // Simulate a desktop session rather than just a process that sleeps.
   // The dropped-env case models the Windows activation stub handing off.
   string bridge=Environment.GetEnvironmentVariable("CODEX_CLI_PATH");
   string image=System.Reflection.Assembly.GetExecutingAssembly().Location;
   if(String.IsNullOrEmpty(bridge)||File.Exists(image+".drop-env")){
    System.Threading.Thread.Sleep(60000);return 0;
   }
   var start=new ProcessStartInfo(bridge,"app-server"){
    UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true
   };
   using(var engine=Process.Start(start)){
    engine.StandardInput.WriteLine("{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"desktop-fixture\",\"version\":\"1\"}}}");
    if(engine.StandardOutput.ReadLine()==null)return 3;
    engine.StandardInput.WriteLine("{\"method\":\"initialized\"}");
    engine.WaitForExit(60000);
   }
   return 0;
  }
  var json=new JavaScriptSerializer();
  if(Array.IndexOf(args,"--print-startup-config")>=0){Console.WriteLine("{\"organizations\":[],\"fixture\":true}");return 0;}
  if(Array.IndexOf(args,"--echo")>=0){Console.Write(json.Serialize(args));Console.Error.Write("stderr-kept");return 23;}
  string line;while((line=Console.ReadLine())!=null){
   var m=json.Deserialize<Dictionary<string,object>>(line);
   if(!m.ContainsKey("id"))continue;
   Console.WriteLine(json.Serialize(new {id=m["id"],result=m.ContainsKey("params")?m["params"]:new object()}));
  }return 0;
 }
}
