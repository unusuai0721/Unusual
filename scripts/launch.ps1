$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopExe = Join-Path $appRoot 'desktop\runtime\electron.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw 'Please extract the complete Unusual portable package.' }
Start-Process -FilePath $desktopExe -ArgumentList ('"' + (Join-Path $appRoot 'desktop') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden | Out-Null
