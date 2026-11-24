# End-to-end test of install.ps1 against locally built release assets.
#
#   <shell> -NoProfile -ExecutionPolicy Bypass -File test/channels/install-ps1.ps1 -Dist <dist-dir> [-Shell powershell|pwsh] [-SkipUserPath]
#
# The installer runs under -Shell (Windows PowerShell 5.1 or PowerShell 7).
# Everything happens under a throwaway USERPROFILE / LOCALAPPDATA / CODEX_HOME
# with fake claude/codex CLIs. The one real thing changed is the user PATH
# (HKCU\Environment), which is checked to be restored byte for byte;
# -SkipUserPath leaves it alone (for running this on a workstation).
param(
  [Parameter(Mandatory = $true)][string]$Dist,
  [string]$Shell = 'powershell',
  [switch]$SkipUserPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Dist = (Resolve-Path -LiteralPath $Dist).Path
$Install = Join-Path $Dist 'install.ps1'
$zip = Get-ChildItem -LiteralPath $Dist -Filter 'worktree-janitor-v*.zip' | Select-Object -First 1
$Version = $zip.BaseName -replace '^worktree-janitor-', ''
$Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$ShellExe = (Get-Command $Shell -CommandType Application | Select-Object -First 1).Source

$Work = Join-Path ([IO.Path]::GetTempPath()) ('wj-ps1-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$HomeDir = Join-Path $Work 'home'
New-Item -ItemType Directory -Path $HomeDir | Out-Null
$env:USERPROFILE = $HomeDir
$env:HOME = $HomeDir
$env:LOCALAPPDATA = Join-Path $HomeDir 'AppData\Local'
New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
$env:CODEX_HOME = Join-Path $HomeDir '.codex'
$env:WORKTREE_JANITOR_BASE_URL = $Dist
$latest = Join-Path $Work 'latest.json'
[IO.File]::WriteAllText($latest, "{`n  `"tag_name`": `"$Version`"`n}`n")
$env:WORKTREE_JANITOR_API_URL = $latest
if ($SkipUserPath) { $env:WORKTREE_JANITOR_NO_USER_PATH = '1' }
$env:GIT_AUTHOR_NAME = 't'; $env:GIT_AUTHOR_EMAIL = 't@example.invalid'; $env:GIT_COMMITTER_NAME = 't'; $env:GIT_COMMITTER_EMAIL = 't@example.invalid'
$InstallDir = Join-Path $env:LOCALAPPDATA 'worktree-janitor'
$BinDir = Join-Path $InstallDir 'bin'
$Launcher = Join-Path $BinDir 'worktree-janitor.cmd'
$CleanPath = $env:Path

function Fail([string]$m) { throw "FAIL: $m" }
function Step([string]$m) { Write-Host "--- $m" }
function Get-UserPathRaw { [string](Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames') }
$UserPathBefore = Get-UserPathRaw

# Run install.ps1 in the shell under test; returns @(exitcode, output).
function Invoke-Installer([string[]]$InstallerArgs, [hashtable]$Env = @{}) {
  # Windows PowerShell 5.1 turns a native command's stderr into error
  # records under 2>&1; with 'Stop' the first one would end this test.
  $ErrorActionPreference = 'Continue'
  $saved = @{}
  foreach ($k in $Env.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Env[$k]) }
  try {
    $out = & $ShellExe -NoProfile -ExecutionPolicy Bypass -File $Install @InstallerArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  Write-Host $out
  return @($code, $out)
}

# Files PowerShell itself keeps under LOCALAPPDATA (startup profile cache,
# module analysis cache) are not ours.
# gh (called by the janitor) keeps a device id under LOCALAPPDATA too.
function Test-Foreign($Item) { return ($Item.FullName -like (Join-Path $env:LOCALAPPDATA 'Microsoft\*')) -or ($Item.FullName -like (Join-Path $env:LOCALAPPDATA 'GitHub CLI\*')) -or ($Item.FullName -like (Join-Path $HomeDir '.config\gh\*')) }

function Get-Snapshot {
  $items = @(Get-ChildItem -LiteralPath $HomeDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { (-not $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) -and -not (Test-Foreign $_) } | Sort-Object FullName | ForEach-Object {
      if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { "$($_.FullName) -> link" }
      else { "$($_.FullName) $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    })
  return (($items + "userpath=$(Get-UserPathRaw)") -join "`n")
}

function Assert-Same([string]$Before, [string]$What) {
  $now = Get-Snapshot
  if ($now -ceq $Before) { return }
  $d = Compare-Object ($Before -split "`n") ($now -split "`n") | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }
  Fail "$What`n$($d -join "`n")"
}

function New-TestRepo([string]$Root) {
  New-Item -ItemType Directory -Path $Root | Out-Null
  Push-Location $Root
  try {
    git init -q --bare origin.git
    git init -q repo
    Set-Location repo
    git checkout -q -b main
    'a' | Out-File -Encoding ascii a; git add a; git commit -qm init
    git remote add origin ../origin.git; git push -q origin main 2>$null
    git remote set-head origin main
    git worktree add -q -b merged ../wt-merged 2>$null
    Push-Location ../wt-merged; 'b' | Out-File -Encoding ascii b; git add b; git commit -qm b; Pop-Location
    git merge -q --no-ff -m merge merged; git push -q origin main 2>$null
    git worktree add -q -b open ../wt-open 2>$null
    Push-Location ../wt-open; 'c' | Out-File -Encoding ascii c; git add c; git commit -qm c; Pop-Location
  } finally { Pop-Location }
}

try {
  Write-Host "installer shell: $ShellExe ($(& $ShellExe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))"

  Step '-DryRun on a fresh machine changes nothing'
  $before = Get-Snapshot
  $r = Invoke-Installer @('-None', '-DryRun')
  if ($r[0] -ne 0) { Fail 'fresh -DryRun failed' }
  Assert-Same $before 'fresh -DryRun changed files'

  Step "install.ps1 $Version -None (version from the latest-release endpoint)"
  $r = Invoke-Installer @('-None')
  if ($r[0] -ne 0) { Fail "install exited $($r[0])" }
  $cur = Get-Item -LiteralPath (Join-Path $InstallDir 'current') -Force
  if (-not ($cur.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 'current is not a junction' }
  if (-not (Test-Path -LiteralPath $Launcher)) { Fail 'launcher missing' }
  if ((Get-Content -LiteralPath $Launcher -Raw) -notmatch [regex]::Escape($Node)) { Fail "launcher does not record $Node" }
  if (Test-Path -LiteralPath $env:CODEX_HOME) { Fail '-None touched CODEX_HOME' }
  if (-not $SkipUserPath) {
    $up = Get-UserPathRaw
    if (@($up.Split(';') | Where-Object { $_ -ieq $BinDir }).Count -ne 1) { Fail "user PATH does not hold $BinDir once: $up" }
    if (((Get-Item -LiteralPath 'HKCU:\Environment').GetValueKind('Path') -ne 'ExpandString') -and ($UserPathBefore -match '%')) { Fail 'user PATH lost REG_EXPAND_SZ' }
  }

  Step 'worktree-janitor --help and a dry run (through cmd.exe, as a new terminal would)'
  $env:Path = "$BinDir;$CleanPath"
  $help = cmd.exe /d /c 'worktree-janitor --help' | Out-String
  if ($help -notmatch 'remove git worktrees') { Fail "--help output: $help" }
  New-TestRepo (Join-Path $Work 'r1')
  Push-Location (Join-Path $Work 'r1\repo')
  $dry = cmd.exe /d /c 'worktree-janitor' | Out-String
  # The launcher works without node on PATH: the absolute node is recorded.
  $env:Path = "$BinDir;$env:SystemRoot\System32;" + (Split-Path (Get-Command git).Source)
  $json = cmd.exe /d /c 'worktree-janitor --json' | Out-String
  $env:Path = "$BinDir;$CleanPath"
  Pop-Location
  Write-Host $dry
  if ($dry -notmatch 'would-remove') { Fail 'dry run did not plan the merged worktree' }
  if ($json -notmatch '"worktrees"') { Fail "launcher without node on PATH: $json" }
  if (-not (Test-Path -LiteralPath (Join-Path $Work 'r1\wt-merged'))) { Fail 'dry run removed something' }

  Step 'install again: idempotent'
  $before = Get-Snapshot
  $r = Invoke-Installer @('-None', '-Version', $Version)
  if ($r[0] -ne 0) { Fail 'second install failed' }
  if ($r[1] -notmatch 'already unpacked') { Fail 'second install downloaded again' }
  Assert-Same $before 'second install changed files'

  Step '-DryRun changes nothing'
  $r = Invoke-Installer @('-None', '-DryRun')
  if ($r[0] -ne 0) { Fail '-DryRun failed' }
  Assert-Same $before '-DryRun changed files'

  Step 'tampered archive: fails closed'
  $bad = Join-Path $Work 'bad'
  New-Item -ItemType Directory -Path $bad | Out-Null
  Copy-Item -Path (Join-Path $Dist '*') -Destination $bad
  $bz = Join-Path $bad $zip.Name
  $bytes = [IO.File]::ReadAllBytes($bz); $bytes[100] = $bytes[100] -bxor 0xff; [IO.File]::WriteAllBytes($bz, $bytes)
  Remove-Item -LiteralPath (Join-Path $InstallDir "$Version\.worktree-janitor-sha256")
  $before = Get-Snapshot
  $r = Invoke-Installer @('-None') @{ WORKTREE_JANITOR_BASE_URL = $bad }
  if ($r[0] -eq 0) { Fail 'tampered archive was accepted' }
  if ($r[1] -notmatch 'sha256 mismatch') { Fail 'no mismatch message' }
  Assert-Same $before 'a failed install changed files'
  $r = Invoke-Installer @('-None')
  if ($r[0] -ne 0) { Fail 'reinstall failed' }

  Step 'no release published: clear error'
  $r = Invoke-Installer @('-None') @{ WORKTREE_JANITOR_API_URL = (Join-Path $Work 'missing.json') }
  if ($r[0] -eq 0) { Fail 'succeeded without a release' }
  if ($r[1] -notmatch 'Pass -Version') { Fail 'unclear error' }

  Step 'truncated installer runs nothing'
  $text = [IO.File]::ReadAllText($Install)
  $trunc = Join-Path $Work 'truncated.ps1'
  [IO.File]::WriteAllText($trunc, $text.Substring(0, [int]($text.Length * 0.6)))
  $before = Get-Snapshot
  & { $ErrorActionPreference = 'Continue'; & $ShellExe -NoProfile -ExecutionPolicy Bypass -File $trunc -Uninstall 2>&1 | Out-Null }
  Assert-Same $before 'a truncated installer changed files'

  Step 'uninstall: nothing left'
  $r = Invoke-Installer @('-Uninstall')
  if ($r[0] -ne 0) { Fail 'uninstall failed' }
  if (Test-Path -LiteralPath $InstallDir) { Fail "install dir left: $InstallDir" }
  $left = @(Get-ChildItem -LiteralPath $HomeDir -Recurse -Force -File | Where-Object { -not (Test-Foreign $_) })
  if ($left.Count) { Fail "left behind: $($left.FullName -join ', ')" }
  if ((Get-UserPathRaw) -cne $UserPathBefore) { Fail "user PATH not restored: $(Get-UserPathRaw)" }

  Step 'fake claude + codex on PATH: auto-detected, hooks run under both PowerShells, uninstall restores'
  $fake = Join-Path $Work 'fakebin'
  New-Item -ItemType Directory -Path $fake | Out-Null
  $state = (Join-Path $Work 'claude-state.json').Replace('\', '/')
  $fakeJs = @"
const fs = require('fs');
const f = '$state';
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { markets: [], plugins: [], calls: [] };
const a = process.argv.slice(2), k = a.join(' ');
let out = '';
if (k === 'plugin marketplace list --json') out = JSON.stringify(s.markets);
else if (k === 'plugin list --json') out = JSON.stringify(s.plugins);
else {
  s.calls.push(k);
  if (a[1] === 'marketplace' && a[2] === 'add') s.markets.push({ name: 'worktree-janitor-marketplace', source: 'directory', path: a[3] });
  else if (a[1] === 'install') s.plugins.push({ id: a[2], scope: 'user', version: '0' });
  else if (a[1] === 'uninstall') s.plugins = [];
  else if (a[1] === 'marketplace' && a[2] === 'remove') s.markets = [];
  else if (a[1] !== 'update' && a[1] !== 'marketplace') process.exit(3);
}
fs.writeFileSync(f, JSON.stringify(s));
process.stdout.write(out);
"@
  [IO.File]::WriteAllText((Join-Path $fake 'fake-claude.js'), $fakeJs)
  [IO.File]::WriteAllText((Join-Path $fake 'claude.cmd'), "@`"$Node`" `"%~dp0fake-claude.js`" %*`r`n")
  [IO.File]::WriteAllText((Join-Path $fake 'codex.cmd'), "@echo codex-cli 0.0.0-fake`r`n")
  New-Item -ItemType Directory -Path $env:CODEX_HOME | Out-Null
  $env:Path = "$fake;$CleanPath"
  $before = Get-Snapshot
  $r = Invoke-Installer @('-DryRun')
  if ($r[0] -ne 0) { Fail 'fresh -DryRun with integrations failed' }
  Assert-Same $before 'fresh -DryRun with integrations changed files'
  $r = Invoke-Installer @()
  if ($r[0] -ne 0) { Fail 'install with integrations failed' }
  $cfg = Get-Content -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml') -Raw
  $cur = (Join-Path $InstallDir 'current\scripts\janitor.mjs').Replace('\', '/')
  if ($cfg -notmatch [regex]::Escape($cur)) { Fail "codex hooks do not point at current: $cfg" }
  if ($cfg -notmatch [regex]::Escape($Node.Replace('\', '\\'))) { Fail "codex hooks do not record $Node" }
  $calls = (Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).calls
  if (-not ($calls | Where-Object { $_ -eq "plugin marketplace add $(Join-Path $InstallDir 'current')" })) { Fail "claude marketplace not added at current: $calls" }

  # The installed SessionStart hook, as Codex runs it: <shell> -NoProfile
  # -Command <command_windows>, payload on stdin, here with node off PATH.
  $hooks = & $Node -e "const t=require('fs').readFileSync(process.argv[1],'utf8');const m=[...t.matchAll(/^command_windows = (.*)$/gm)].map(x=>JSON.parse(x[1]));process.stdout.write(JSON.stringify(m))" (Join-Path $env:CODEX_HOME 'config.toml') | ConvertFrom-Json
  $cmd = @($hooks)[0]
  $ran = 0
  foreach ($sh in @('powershell', 'pwsh')) {
    $exe = Get-Command $sh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { continue }
    Write-Host "    SessionStart hook via $sh -NoProfile -Command"
    $repo = Join-Path $Work "r2-$sh"
    New-TestRepo $repo
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe.Source
    # One argument, quoted the way Rust's std (Codex) quotes it: the command
    # holds no double quotes, so wrapping it is enough.
    $psi.Arguments = '-NoProfile -Command "' + $cmd + '"'
    $psi.WorkingDirectory = Join-Path $repo 'repo'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['Path'] = "$env:SystemRoot\System32;" + (Split-Path (Get-Command git).Source)
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write('{"hook_event_name":"SessionStart","source":"startup","cwd":"' + (Join-Path $repo 'repo').Replace('\', '/') + '"}')
    $p.StandardInput.Close()
    $o = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    Write-Host $o
    if ($p.ExitCode -ne 0) { Fail "${sh}: hook exited $($p.ExitCode)" }
    if (Test-Path -LiteralPath (Join-Path $repo 'wt-merged')) { Fail "${sh}: hook did not remove the merged worktree" }
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'wt-open'))) { Fail "${sh}: hook removed the unmerged worktree" }
    $ran++
  }
  if ($ran -eq 0) { Fail 'no PowerShell ran the hook' }

  Step 'install again with the integrations: idempotent'
  $before = Get-Snapshot
  $r = Invoke-Installer @()
  if ($r[0] -ne 0) { Fail 'second install with integrations failed' }
  Assert-Same $before 'second install changed files'

  Step 'uninstall with the integrations'
  $r = Invoke-Installer @('-Uninstall')
  if ($r[0] -ne 0) { Fail 'uninstall with integrations failed' }
  $s = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
  if (@($s.markets).Count -or @($s.plugins).Count) { Fail 'claude plugin left' }
  $left = @(Get-ChildItem -LiteralPath $HomeDir -Recurse -Force -File | Where-Object { -not (Test-Foreign $_) })
  if ($left.Count) { Fail "left behind: $($left.FullName -join ', ')" }
  if ((Get-UserPathRaw) -cne $UserPathBefore) { Fail 'user PATH not restored' }
  Write-Host 'install.ps1: all checks passed'
} finally {
  $env:Path = $CleanPath
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
