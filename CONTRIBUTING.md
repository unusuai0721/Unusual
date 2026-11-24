# 源码与构建

`app/` 是本机服务、消息引擎和界面，`desktop/` 是 Electron 桌面外壳和 Windows 启动及安装源码，`tests/` 是本地测试。

## 本地开发

安装 Node.js 24，在仓库根目录执行：

```powershell
npm test
npm start
```

在终端输出中找到本机管理入口。使用独立目录做开发或演示，避免把真实配置和数据复制进仓库。启动会在程序目录下创建本机数据目录和随机令牌。

## 构建 Windows 发行包

准备解压后的 Windows x64 Node.js 24.19.0 ZIP 和 Electron 45.0.0 ZIP。保留各自包内的许可证。使用 Windows 自带的 .NET Framework 4.x C# 编译器和 PowerShell 7：

```powershell
pwsh -File scripts/build-public.ps1 -NodeDirectory C:\deps\node -ElectronDirectory C:\deps\electron
```

默认输出到 `dist/`。脚本使用明确的文件清单创建便携 ZIP 与独立 EXE 安装器，并写入 SHA-256 校验文件。公开测试使用模拟接口与测试数据，不需要登录 QQ。

## 梗库数据

发行包自带 CC BY 4.0 中文网络梗词库。词条导入时按标题跳过已存在的条目。也可以从旧版数据追加词条。

从 dsh-memewiki 0.1.2 对应版本自行取得 `data/memes.db`，在应用关闭时运行以下命令。在便携包或安装版目录中可使用 `runtime\node.exe` 代替 `node`。

```powershell
node scripts/import-memes.mjs "C:\your-files\memes.db"
```

下次启动时导入至本机数据库。数据的权利信息见上游 NOTICE；也可以直接在应用中逐条创建自己的词条。 [对应版本源码](https://github.com/thawline/dsh-memewiki/tree/15c3c34149dfb0d5ea3a9b3a4b4f0d7f91318e91)

报告问题时请附版本号、重现步骤和脱敏后的错误信息。不要提交应用 `data/`、密钥、QQ 登录资料或他人的聊天记录。

### 校验随包组件

Windows 上可用 Python 3.11 或更新版本运行 `python scripts/build-napcat-component.py NapCat.Shell.Windows.Node.zip nap.zip`。脚本只接受已固定摘要的 v4.18.42 归档，并核对产物哈希。源码包已带原始组件归档，位于 `app/resources/nap.zip`。重新构建时可对照该文件的 SHA-256。
