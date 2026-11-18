using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
class Unusual {
 [STAThread] static void Main(string[] args) {
  try { var root=AppDomain.CurrentDomain.BaseDirectory;var exe=Path.Combine(root,"desktop","runtime","electron.exe");
   if(!File.Exists(exe))throw new Exception("请解压完整的软件文件夹后运行。");
   var info=new ProcessStartInfo(exe,"\""+Path.Combine(root,"desktop")+"\"");if(args.Length==1 && args[0]=="--quit")info.Arguments+=" --quit";info.WorkingDirectory=root;info.UseShellExecute=false;info.CreateNoWindow=true;
   info.EnvironmentVariables["TEMP"]=Path.Combine(root,"data","temp");info.EnvironmentVariables["TMP"]=info.EnvironmentVariables["TEMP"];Directory.CreateDirectory(info.EnvironmentVariables["TEMP"]);
   Process.Start(info);
  }catch(Exception e){MessageBox.Show(e.Message,"Unusual启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}
 }
}
