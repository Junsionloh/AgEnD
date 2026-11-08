# Starts the pane service the way the Runtime does (node <bundle>\dist\runtime-pane-service.js <directory> <scope>) and reports whether it came up.
param([Parameter(Mandatory)][string]$Bundle)
$ErrorActionPreference = "Stop"
$directory = Join-Path $env:TEMP ("agend-pane-demo-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $directory | Out-Null
$scope = "a" * 64
$process = Start-Process -FilePath node -ArgumentList @("$Bundle\dist\runtime-pane-service.js", $directory, $scope) -WindowStyle Hidden -PassThru
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  Start-Sleep -Milliseconds 250
  if ($process.HasExited) { break }
  if (Get-ChildItem -Path $directory -File -Recurse -ErrorAction SilentlyContinue) { $up = $true }
}
if ($up) { Write-Output "pane host started: process alive, descriptor written (state files: $((Get-ChildItem -Path $directory -File -Recurse).Count))" }
elseif ($process.HasExited) { Write-Output "pane host did not start: the process exited with code $($process.ExitCode) before writing its descriptor" }
else { Write-Output "pane host did not start: no descriptor within 10 s" }
if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }   # the one process started above
Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
