using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Installer {
    private static readonly HashSet<string> Folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "app","desktop","scripts","runtime","licenses","docs"
    };
    private static readonly HashSet<string> Files = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Unusual.exe","Start.cmd","Stop.cmd","package.json","README.md","CHANGELOG.md","LICENSE","THIRD-PARTY.md"
    };

    [STAThread]
    private static int Main(string[] args) {
        bool automatic = args.Length == 3 && args[0] == "--apply-update";
        bool test = args.Length == 2 && (args[0] == "--install-dir" || args[0] == "--upgrade-dir");
        try {
            string root;
            if (automatic || test) {
                if (!Path.IsPathRooted(args[1])) throw new IOException("需要绝对路径");
                root = Path.GetFullPath(args[1]);
            } else {
                if (args.Length != 0) throw new IOException("安装参数无效");
                using (var picker = new FolderBrowserDialog()) {
                    picker.Description = "全新安装请选择父目录；升级请选择原先存放 Unusual.exe 的文件夹。升级前请从托盘退出。";
                    if (picker.ShowDialog() != DialogResult.OK) return 0;
                    root = picker.SelectedPath;
                    if (!File.Exists(Path.Combine(root,"Unusual.exe"))) root = Path.Combine(root,"Unusual");
                }
            }
            bool upgrade = automatic || (test ? args[0]=="--upgrade-dir" : Directory.Exists(root));
            if (!test && !automatic && upgrade && MessageBox.Show("保留当前数据并更新以下目录？\n"+root,
                "原地升级",MessageBoxButtons.YesNo)!=DialogResult.Yes) return 0;
            if (automatic) {
                int pid=int.Parse(args[2]);
                try { using(var p=Process.GetProcessById(pid)) if(!p.WaitForExit(120000)) throw new IOException("旧程序尚未退出，原数据已保留"); }
                catch(ArgumentException) { /* already exited */ }
            }
            using(var sha=SHA256.Create())
            using(var mutex=new Mutex(false,"Local\\Unusual.Setup."+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-",""))) {
                bool locked=false;
                try {
                    try { locked=mutex.WaitOne(0); } catch(AbandonedMutexException) { locked=true; }
                    if(!locked) throw new IOException("另一项更新正在进行");
                    if(upgrade) Upgrade(root); else Install(root);
                } finally { if(locked) mutex.ReleaseMutex(); }
            }
            if (automatic || (!test && MessageBox.Show("安装完成。\n"+root+"\n现在打开 Unusual？",
                "Unusual",MessageBoxButtons.YesNo)==DialogResult.Yes))
                Process.Start(new ProcessStartInfo(Path.Combine(root,"Unusual.exe")){WorkingDirectory=root,UseShellExecute=true});
            return 0;
        } catch(Exception e) {
            if(test) Console.Error.WriteLine(e.Message);
            else MessageBox.Show(e.Message,"Unusual 更新未完成",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void NoLinks(string full) {
        for(string p=Path.GetFullPath(full);p!=null;p=Path.GetDirectoryName(p)) {
            try { if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new IOException("路径中含链接，已停止："+p); }
            catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
        }
    }
    private static string Target(string root,string relative) {
        string[] parts=relative.Replace('\\','/').Split('/');
        foreach(string part in parts) if(part.Length==0 || part=="." || part==".." || part.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || part.EndsWith(".") || part.EndsWith(" ")) throw new IOException("无效的更新文件名");
        if(!(parts.Length==1 ? Files.Contains(parts[0]) : Folders.Contains(parts[0]))) throw new IOException("更新包包含非程序文件");
        string result=Path.Combine(root,String.Join(Path.DirectorySeparatorChar.ToString(),parts));NoLinks(result);return result;
    }
    private static Version VersionOf(string folder) {
        string file=Path.Combine(folder,"package.json");NoLinks(file);
        var json=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
        Version version=Version.Parse((string)json["version"]);
        if((string)json["name"]!="unusual-local-qq"||version.Major<1) throw new IOException("仅能更新 Unusual 公开版");
        return version;
    }
    private static List<string> Extract(string dir) {
        Directory.CreateDirectory(dir);
        var names=new List<string>();
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("unusual-payload.zip"))
        using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
            foreach(var entry in zip.Entries) {
                if(entry.Name.Length==0) continue;
                string name=entry.FullName.Replace('\\','/'),dest=Target(dir,name);
                Directory.CreateDirectory(Path.GetDirectoryName(dest));entry.ExtractToFile(dest);names.Add(name);
            }
        }
        if(!names.Contains("Unusual.exe")||!names.Contains("app/server.mjs")||!names.Contains("app/resources/emoji-starter.zip"))
            throw new IOException("安装包不完整");
        VersionOf(dir);return names;
    }
    private static void Install(string root) {
        NoLinks(root);
        if(Directory.Exists(root)||File.Exists(root)) throw new IOException("目标已存在，请使用原地升级");
        string parent=Path.GetDirectoryName(root);
        if(String.IsNullOrEmpty(parent)||!Directory.Exists(parent)) throw new IOException("父目录不存在");
        string stage=Path.Combine(parent,".unusual-install-"+Guid.NewGuid().ToString("N"));
        try {Extract(stage);Directory.Move(stage,root);}
        finally {if(Directory.Exists(stage)) Directory.Delete(stage,true);}
    }
    private static void RequireStopped(string root) {
        foreach(string name in new[]{"electron","node"}) foreach(var process in Process.GetProcessesByName(name)) using(process) {
            string file;
            try {file=process.MainModule.FileName;} catch(System.ComponentModel.Win32Exception){continue;} catch(InvalidOperationException){continue;}
            if(String.Equals(file,Path.Combine(root,"desktop","runtime","electron.exe"),StringComparison.OrdinalIgnoreCase)||
               String.Equals(file,Path.Combine(root,"runtime","node.exe"),StringComparison.OrdinalIgnoreCase))
                throw new IOException("请从原版 Unusual 的托盘菜单退出，稍后重试升级。");
        }
    }
    private static void RollBack(string root,string job) {
        string plan=Path.Combine(job,"plan.txt");
        if(!File.Exists(plan)||File.Exists(Path.Combine(job,"complete")))return;
        var lines=File.ReadAllLines(plan);Array.Reverse(lines);
        foreach(var line in lines) {
            string rel=line.Substring(2),dest=Target(root,rel),backup=Target(Path.Combine(job,"old"),rel),stage=Target(Path.Combine(job,"new"),rel);
            if(File.Exists(backup)) {if(File.Exists(dest)) File.Delete(dest);File.Move(backup,dest);}
            else if(line.StartsWith("+ ")&&!File.Exists(stage)&&File.Exists(dest)) File.Delete(dest);
        }
    }
    private static void ValidateJobTree(string dir) {
        NoLinks(dir);
        foreach(var item in Directory.GetFileSystemEntries(dir)) {
            NoLinks(item);if(Directory.Exists(item))ValidateJobTree(item);
        }
    }
    private static void Upgrade(string root) {
        NoLinks(root);
        if(!Directory.Exists(root)||Directory.Exists(Path.Combine(root,".git")))throw new IOException("请选择已安装的公开版目录");
        RequireStopped(root);
        string job=Path.Combine(root,".unusual-update-v1");
        if(Directory.Exists(job)) {
            ValidateJobTree(job);
            if(!File.Exists(Path.Combine(job,"installer-owned")))throw new IOException("更新暂存目录已被占用");
            RollBack(root,job);Directory.Delete(job,true);
        }
        var current=VersionOf(root);
        if(!File.Exists(Path.Combine(root,"Unusual.exe"))||!File.Exists(Path.Combine(root,"app","server.mjs")))throw new IOException("原安装不完整");
        Directory.CreateDirectory(job);
        File.WriteAllText(Path.Combine(job,"installer-owned"),"Unusual");
        string stage=Path.Combine(job,"new"),old=Path.Combine(job,"old");
        bool clean=false;
        try {
            var names=Extract(stage);
            if(VersionOf(stage)<current)throw new IOException("不能使用旧版本覆盖新版");
            var lines=new List<string>();
            foreach(var rel in names) {
                string dest=Target(root,rel);
                if(Directory.Exists(dest))throw new IOException("目录与程序文件重名："+rel);
                lines.Add((File.Exists(dest)?"= ":"+ ")+rel);
            }
            string plan=Path.Combine(job,"plan.txt");
            File.WriteAllLines(plan+".tmp",lines);File.Move(plan+".tmp",plan);
            foreach(var rel in names) {
                string dest=Target(root,rel),backup=Target(old,rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                if(File.Exists(dest)){Directory.CreateDirectory(Path.GetDirectoryName(backup));File.Move(dest,backup);}
                File.Move(Target(stage,rel),dest);
            }
            File.WriteAllText(Path.Combine(job,"complete"),"ok");clean=true;
        } catch {RollBack(root,job);clean=true;throw;}
        finally {if(clean){ValidateJobTree(job);Directory.Delete(job,true);}}
    }
}
