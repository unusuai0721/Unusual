using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Installer
{
    private const string Name = "Unusual";

    [STAThread]
    private static int Main(string[] args)
    {
        bool unattended = args.Length == 2 && args[0] == "--install-dir";
        try
        {
            string destination;
            if (unattended)
            {
                if (!Path.IsPathRooted(args[1])) throw new IOException("请使用绝对安装路径。");
                destination = Path.GetFullPath(args[1]);
            }
            else
            {
                using (var picker = new FolderBrowserDialog())
                {
                    picker.Description = "选择安装位置。安装程序会在所选位置内新建 Unusual 文件夹。";
                    picker.SelectedPath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    if (picker.ShowDialog() != DialogResult.OK) return 0;
                    destination = Path.Combine(picker.SelectedPath, Name);
                }
            }

            Install(destination);
            if (!unattended && MessageBox.Show("安装完成。\n" + destination + "\n\n现在打开 Unusual？",
                "Unusual 安装", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
            {
                Process.Start(new ProcessStartInfo(Path.Combine(destination, "Unusual.exe")) {
                    WorkingDirectory = destination, UseShellExecute = true
                });
            }
            return 0;
        }
        catch (Exception error)
        {
            if (unattended) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "Unusual 安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Install(string destination)
    {
        if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException("目标路径已存在。请选择其他位置，以免覆盖现有安装和聊天数据。");
        string parent = Path.GetDirectoryName(destination);
        if (String.IsNullOrEmpty(parent) || !Directory.Exists(parent))
            throw new IOException("请选择存在的父目录。");
        string stage = Path.Combine(parent, ".unusual-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("unusual-payload.zip"))
            {
                if (payload == null) throw new IOException("安装包缺少应用文件。");
                using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    foreach (var entry in archive.Entries)
                    {
                        string target = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                        if (!target.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                            throw new IOException("安装包包含无效路径。");
                        if (entry.Name.Length == 0) Directory.CreateDirectory(target);
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            entry.ExtractToFile(target);
                        }
                    }
                }
            }
            if (!File.Exists(Path.Combine(stage, "Unusual.exe"))) throw new IOException("安装包不完整。");
            Directory.Move(stage, destination);
        }
        finally
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
        }
    }
}
