param(
    [Parameter(Mandatory=$true)][string]$NodeDirectory,
    [Parameter(Mandatory=$true)][string]$ElectronDirectory,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
if(!$OutputDirectory){$OutputDirectory=Join-Path $source 'dist'}
$out = [IO.Path]::GetFullPath($OutputDirectory)
$version=(Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
$base = "Unusual-$version-Windows-x64"
$zip=Join-Path $out "$base-Portable.zip"
$setup=Join-Path $out "$base-Setup.exe"
$stage=Join-Path $out ('.stage-'+[Guid]::NewGuid().ToString('N'))
if([IO.Path]::GetDirectoryName($stage) -ne $out){throw 'Invalid staging location'}
if((Test-Path -LiteralPath $zip) -or (Test-Path -LiteralPath $setup)){throw 'Output already exists'}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    foreach($file in @('app\server.mjs','app\lib','app\public','app\resources\emoji-starter.zip','desktop\main.cjs','desktop\preload.cjs','desktop\icon.ico','desktop\package.json','scripts\launch.ps1','scripts\stop.ps1','scripts\import-memes.mjs','licenses','docs\screenshots','Start.cmd','Stop.cmd','README.md','CHANGELOG.md','LICENSE','THIRD-PARTY.md','package.json')){
        $dest=Join-Path $stage $file
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $dest -Recurse
    }
    $runtime=Join-Path $stage 'runtime'
    New-Item -ItemType Directory -Path $runtime | Out-Null
    Copy-Item -LiteralPath (Join-Path $NodeDirectory 'node.exe') -Destination $runtime
    Copy-Item -LiteralPath (Join-Path $NodeDirectory 'LICENSE.txt') -Destination $runtime
    Copy-Item -LiteralPath $ElectronDirectory -Destination (Join-Path $stage 'desktop\runtime') -Recurse
    if(!(Test-Path -LiteralPath (Join-Path $stage 'desktop\runtime\electron.exe'))){throw 'Missing Electron runtime'}
    $icon=Join-Path $source 'desktop\icon.ico'
    & $csc /nologo /codepage:65001 /target:winexe /platform:x64 "/win32icon:$icon" "/out:$stage\Unusual.exe" (Join-Path $source 'desktop\launcher.cs')
    if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed'}

    $payload=Join-Path $out ('.payload-'+[Guid]::NewGuid().ToString('N')+'.zip')
    $payload=[IO.Path]::GetFullPath($payload)
    [IO.Compression.ZipFile]::CreateFromDirectory($stage,$payload,[IO.Compression.CompressionLevel]::Optimal,$false)
    Copy-Item -LiteralPath $payload -Destination $zip
    & $csc /nologo /codepage:65001 /target:winexe /platform:x64 /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payload,unusual-payload.zip" "/win32icon:$icon" "/out:$setup" (Join-Path $source 'desktop\installer.cs')
    if($LASTEXITCODE -ne 0){throw 'Installer compilation failed'}
    $checks = foreach ($asset in (@($zip,$setup) + @(Get-ChildItem -LiteralPath $out -Filter 'Unusual-NapCat-4.18.42-Windows-x64.zip' -File | Select-Object -ExpandProperty FullName))) {
        $hash=(Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($asset))"
    }
    $checks | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt') -Encoding ascii
} finally {
    if($payload -and [IO.Path]::GetDirectoryName($payload) -eq $out -and (Test-Path -LiteralPath $payload)){Remove-Item -LiteralPath $payload -Force}
    if((Resolve-Path -LiteralPath $stage).ProviderPath -eq $stage -and [IO.Path]::GetDirectoryName($stage) -eq $out -and !(Get-Item -LiteralPath $stage).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
