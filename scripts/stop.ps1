$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Start-Process -FilePath (Join-Path $appRoot 'Unusual.exe') -ArgumentList '--quit' -WorkingDirectory $appRoot -WindowStyle Hidden | Out-Null
