# worktree-janitor installer for Windows. Windows PowerShell 5.1 or PowerShell 7+, no admin.
#
#   irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.ps1))) -Version v0.1.0 -Codex
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version v0.1.0 -All
#
# What it does:
#   1. downloads worktree-janitor-<version>.zip and SHA256SUMS from the GitHub
#      release and verifies the hash (any doubt aborts the install),
#   2. unpacks it to <Dir>\<version> and points the junction <Dir>\current at it,
#   3. writes the launcher <Dir>\bin\worktree-janitor.cmd (plus an sh launcher
#      for Git Bash) that runs the node found at install time (absolute path),
#      and adds <Dir>\bin to the user PATH,
#   4. runs `node <Dir>\current\scripts\install.mjs --claude/--codex` for the
#      CLIs selected (default: the ones found on PATH).
# Running it again is safe.
#
# Environment (optional):
#   WORKTREE_JANITOR_BASE_URL  where the release assets are (default: the GitHub
#                              release of -Version); https://, file:// or a local directory
#   WORKTREE_JANITOR_API_URL   latest-release endpoint (default: GitHub API)
#   HTTPS_PROXY                proxy for the downloads (credentials in the URL are supported)
#   WORKTREE_JANITOR_NO_USER_PATH=1  leave the user PATH alone (add <Dir>bin yourself)
#
# Everything runs inside Install-WorktreeJanitor, called on the last line, so
# a truncated download runs nothing.

param(
  [string]$Version = '',
  [string]$Dir = '',
  [string]$Node = '',
  [switch]$Claude,
  [switch]$Codex,
  [switch]$All,
  [switch]$None,
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Help
)

function Install-WorktreeJanitor {
  param(
    [string]$Version, [string]$Dir, [string]$Node,
    [bool]$Claude, [bool]$Codex, [bool]$All, [bool]$None, [bool]$Uninstall, [bool]$DryRun, [bool]$Help
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version 2.0
  $Repo = 'erictheng93/worktree-janitor'
  $Marker = 'installed by worktree-janitor install.ps1'

  function Say([string]$s) { Write-Host $s }
  function Fail([string]$s) { throw "install.ps1: error: $s" }

  if ($Help) {
    Say @'
worktree-janitor installer (Windows)

  install.ps1 [-Version vX.Y.Z] [-Dir DIR] [-Node PATH]
              [-Claude] [-Codex] [-All] [-None] [-Uninstall] [-DryRun]

  -Version vX.Y.Z  release to install (default: the latest release)
  -Dir DIR         install root (default: %LOCALAPPDATA%\worktree-janitor)
  -Node PATH       node.exe to use (default: node on PATH; Node.js 18+)
  -Claude          also set up the Claude Code plugin (needs claude on PATH)
  -Codex           also set up Codex hooks, skill and AGENTS.md rule
  -All             both
  -None            neither (files and launcher only)
                   default: every CLI of the two that is on PATH
  -Uninstall       remove the integrations (all unless -Claude, -Codex or -None),
                   the launcher, the user PATH entry and DIR
  -DryRun          print what would happen, change nothing
'@
    return
  }
  if ($None -and ($Claude -or $Codex -or $All)) { Fail '-None cannot be combined with -Claude, -Codex or -All' }
  if ($All) { $Claude = $true; $Codex = $true }
  $picked = $Claude -or $Codex -or $None
  $pre = if ($DryRun) { 'would ' } else { '' }

  if (-not $Dir) {
    if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set; pass -Dir' }
    $Dir = Join-Path $env:LOCALAPPDATA 'worktree-janitor'
  }
  $Dir = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
  $Current = Join-Path $Dir 'current'
  $BinDir = Join-Path $Dir 'bin'
  $LauncherCmd = Join-Path $BinDir 'worktree-janitor.cmd'
  $LauncherSh = Join-Path $BinDir 'worktree-janitor'

  # PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub refuses.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  function Get-ProxyArgs {
    $p = $env:HTTPS_PROXY
    if (-not $p) { $p = $env:https_proxy }
    if (-not $p) { return @{} }
    $u = [Uri]$p
    $a = @{ Proxy = $u.GetLeftPart([UriPartial]::Authority) }
    if ($u.UserInfo) {
      $parts = $u.UserInfo.Split(':', 2)
      $pw = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString($parts[1]) } else { '' }
      $sec = New-Object System.Security.SecureString
      foreach ($ch in $pw.ToCharArray()) { $sec.AppendChar($ch) }
      $a.ProxyCredential = New-Object System.Management.Automation.PSCredential ([Uri]::UnescapeDataString($parts[0]), $sec)
    }
    return $a
  }

  function Get-File([string]$Url, [string]$Dest) {
    if ($Url -match '^file://') { $Url = ([Uri]$Url).LocalPath }
    if ($Url -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]+://') {
      if (-not (Test-Path -LiteralPath $Url -PathType Leaf)) { throw "not found: $Url" }
      Copy-Item -LiteralPath $Url -Destination $Dest -Force
      return
    }
    if ($Url -notmatch '^https://') { throw 'refusing to download over a non-https URL' }
    $proxy = Get-ProxyArgs
    $last = $null
    for ($i = 1; $i -le 3; $i++) {
      try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 120 -Headers @{ 'User-Agent' = 'worktree-janitor-installer' } @proxy
        return
      } catch {
        $last = $_
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($code -eq 404) { break }
        Start-Sleep -Seconds $i
      }
    }
    throw $last
  }

  function Test-Ours([string]$Path) {
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and ((Get-Content -LiteralPath $Path -Raw) -match [regex]::Escape($Marker))
  }

  function Test-Link([string]$Path) {
    $i = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null -ne $i -and (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  }

  # Remove a junction itself, never what it points to.
  function Remove-Link([string]$Path) { [System.IO.Directory]::Delete($Path, $false) }

  function Find-Node {
    $n = $Node
    if (-not $n) {
      $c = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($c) { $n = $c.Source }
    }
    if (-not $n) { Fail 'node (Node.js 18 or newer) is not on PATH; install it first (winget install OpenJS.NodeJS.LTS) or pass -Node PATH' }
    if (-not [System.IO.Path]::IsPathRooted($n) -or -not (Test-Path -LiteralPath $n -PathType Leaf)) { Fail "-Node must be the absolute path of node.exe: $n" }
    # `node --version` prints vMAJOR.MINOR.PATCH. (No -e script: Windows
    # PowerShell 5.1 drops the double quotes inside native arguments.)
    $v = [string](& $n --version)
    if ($LASTEXITCODE -ne 0 -or $v -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) { Fail "$n is not Node.js 18 or newer ($v)" }
    return [System.IO.Path]::GetFullPath($n)
  }

  function Get-UserPath {
    $k = Get-Item -LiteralPath 'HKCU:\Environment'
    return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  }

  # Write the user PATH as REG_EXPAND_SZ (keeps %VARS% unexpanded), then
  # broadcast WM_SETTINGCHANGE through a throwaway variable so new shells see it.
  function Set-UserPath([string]$Value) {
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $Value -Type ExpandString
    [Environment]::SetEnvironmentVariable('WORKTREE_JANITOR_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('WORKTREE_JANITOR_PATH_REFRESH', $null, 'User')
  }

  function Test-PathHas([string]$PathValue, [string]$Entry) {
    foreach ($p in $PathValue.Split(';')) {
      if ($p -and ([Environment]::ExpandEnvironmentVariables($p).TrimEnd('\') -ieq $Entry)) { return $true }
    }
    return $false
  }

  # Append so that Remove-PathEntry gives back the exact original string: after
  # a trailing ';' the entry goes in as 'entry;', otherwise as ';entry'.
  function Add-PathEntry([string]$PathValue, [string]$Entry) {
    if (-not $PathValue) { return $Entry }
    if ($PathValue.EndsWith(';')) { return "$PathValue$Entry;" }
    return "$PathValue;$Entry"
  }

  function Remove-PathEntry([string]$PathValue, [string]$Entry) {
    if ($PathValue -ieq $Entry) { return '' }
    if ($PathValue.EndsWith(";$Entry;", [StringComparison]::OrdinalIgnoreCase)) { return $PathValue.Substring(0, $PathValue.Length - $Entry.Length - 1) }
    if ($PathValue.EndsWith(";$Entry", [StringComparison]::OrdinalIgnoreCase)) { return $PathValue.Substring(0, $PathValue.Length - $Entry.Length - 1) }
    # Moved or edited by hand: drop every entry that resolves to it.
    return (@($PathValue.Split(';') | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ine $Entry }) -join ';')
  }

  function Invoke-Integration([string]$NodeExe, [string]$Root, [string]$Kind, [string[]]$Extra) {
    $script = Join-Path $Root 'scripts\install.mjs'
    & $NodeExe $script "--$Kind" --root $Current --node $NodeExe @Extra | Out-Host
    return ($LASTEXITCODE -eq 0)
  }

  if ($Uninstall) {
    if (-not $picked) { $Claude = $true; $Codex = $true }
    $ok = $true
    if ($Claude -or $Codex) {
      $n = $Node
      if (-not $n) { $c = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $n = $c.Source } }
      if ((Test-Path -LiteralPath (Join-Path $Current 'scripts\install.mjs')) -and $n) {
        $extra = @('--uninstall'); if ($DryRun) { $extra += '--dry-run' }
        if ($Claude) { if (-not (Invoke-Integration $n $Current 'claude' $extra)) { $ok = $false } }
        if ($Codex) { if (-not (Invoke-Integration $n $Current 'codex' $extra)) { $ok = $false } }
      } else {
        Say "  skipped Claude Code / Codex cleanup: no $Current\scripts\install.mjs or no node"
      }
    }
    if (-not $ok) { Fail "integration cleanup failed; the files under $Dir are kept so you can retry" }
    foreach ($l in @($LauncherCmd, $LauncherSh)) {
      if (Test-Ours $l) { Say "  ${pre}delete $l"; if (-not $DryRun) { Remove-Item -LiteralPath $l -Force } }
      elseif (Test-Path -LiteralPath $l) { Say "  kept $l (not installed by worktree-janitor)" }
    }
    $up = if ($env:WORKTREE_JANITOR_NO_USER_PATH -eq '1') { '' } else { Get-UserPath }
    if (Test-PathHas $up $BinDir) {
      Say "  ${pre}remove $BinDir from the user PATH"
      if (-not $DryRun) {
        Set-UserPath (Remove-PathEntry $up $BinDir)
      }
    }
    if (Test-Link $Current) { Say "  ${pre}delete $Current"; if (-not $DryRun) { Remove-Link $Current } }
    if (Test-Path -LiteralPath $Dir) {
      foreach ($d in @(Get-ChildItem -LiteralPath $Dir -Directory -Force | Where-Object { $_.Name -like 'v*' -or $_.Name -like '.staging.*' })) {
        if (Test-Link $d.FullName) { continue }
        if (-not ((Test-Path -LiteralPath (Join-Path $d.FullName '.worktree-janitor-install')) -or (Test-Path -LiteralPath (Join-Path $d.FullName '.worktree-janitor-sha256')))) { continue }
        Say "  ${pre}delete $($d.FullName)"
        if (-not $DryRun) { Remove-Item -LiteralPath $d.FullName -Recurse -Force }
      }
      if (-not $DryRun) {
        if ((Test-Path -LiteralPath $BinDir) -and -not (Get-ChildItem -LiteralPath $BinDir -Force)) { Remove-Item -LiteralPath $BinDir -Force }
        if (-not (Get-ChildItem -LiteralPath $Dir -Force)) { Remove-Item -LiteralPath $Dir -Force; Say "  deleted $Dir" }
        else { Say "  kept $Dir (it holds files worktree-janitor did not install)" }
      }
    }
    if ($DryRun) { Say 'Dry run: nothing was changed.' } else { Say 'Uninstalled.' }
    return
  }

  $NodeExe = Find-Node
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say 'warning: git is not on PATH; worktree-janitor needs git 2.7 or newer at run time (winget install Git.Git)' }
  if (-not $picked) {
    if (Get-Command claude -ErrorAction SilentlyContinue) { $Claude = $true }
    if (Get-Command codex -ErrorAction SilentlyContinue) { $Codex = $true }
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("worktree-janitor-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    if (-not $Version) {
      $api = if ($env:WORKTREE_JANITOR_API_URL) { $env:WORKTREE_JANITOR_API_URL } else { "https://api.github.com/repos/$Repo/releases/latest" }
      $rel = $null
      try { Get-File $api (Join-Path $tmp 'latest.json'); $rel = Get-Content -LiteralPath (Join-Path $tmp 'latest.json') -Raw | ConvertFrom-Json } catch { }
      if (-not $rel -and -not $env:WORKTREE_JANITOR_API_URL) {
        # The API allows 60 unauthenticated requests an hour per IP. github.com/<repo>/releases/latest
        # redirects to .../releases/tag/<tag> without that limit.
        try {
          $proxy = Get-ProxyArgs
          $r = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -Method Head -UseBasicParsing -TimeoutSec 60 -Headers @{ 'User-Agent' = 'worktree-janitor-installer' } @proxy
          $final = if ($r.BaseResponse.ResponseUri) { $r.BaseResponse.ResponseUri } else { $r.BaseResponse.RequestMessage.RequestUri }
          if ([string]$final -match '/releases/tag/([^/?#]+)$') { $rel = [pscustomobject]@{ tag_name = $Matches[1] } }
        } catch { }
      }
      if (-not $rel) { Fail "could not look up the latest release of $Repo (none published yet, or no network). Pass -Version vX.Y.Z" }
      if (-not ($rel.PSObject.Properties.Name -contains 'tag_name') -or -not $rel.tag_name) { Fail 'the latest-release response has no tag_name; pass -Version vX.Y.Z' }
      $Version = [string]$rel.tag_name
    }
    if ($Version -notmatch '^v') { $Version = "v$Version" }
    if ($Version -notmatch '^v[0-9][0-9A-Za-z.-]*$') { Fail "bad version: $Version" }
    $asset = "worktree-janitor-$Version.zip"
    $base = if ($env:WORKTREE_JANITOR_BASE_URL) { $env:WORKTREE_JANITOR_BASE_URL.TrimEnd('/', '\') } else { "https://github.com/$Repo/releases/download/$Version" }
    $sep = if ($base -match '^[a-zA-Z][a-zA-Z0-9+.-]+://') { '/' } else { '\' }
    $target = Join-Path $Dir $Version
    Say "worktree-janitor $Version -> $target"

    $sums = Join-Path $tmp 'SHA256SUMS'
    try { Get-File ("$base$sep" + 'SHA256SUMS') $sums } catch { Fail "could not download SHA256SUMS for $Version (does the release exist?)" }
    $want = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -eq $asset) { $want = $Matches[1].ToLowerInvariant(); break }
    }
    if (-not $want) { Fail "SHA256SUMS has no entry for $asset" }

    $stamp = Join-Path $target '.worktree-janitor-sha256'
    $src = $null
    if ((Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $want) -and (Test-Path -LiteralPath (Join-Path $target 'scripts\janitor.mjs'))) {
      Say "  ok $target (already unpacked, sha256 $want)"
      $src = $target
    } else {
      $zip = Join-Path $tmp $asset
      try { Get-File ("$base$sep" + $asset) $zip } catch { Fail "could not download ${asset}: $($_.Exception.Message)" }
      $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($got -ne $want) { Fail "sha256 mismatch for ${asset}: expected $want, got $got. Nothing was installed." }
      Say "  verified $asset (sha256 $want)"
      $x = Join-Path $tmp 'x'
      Expand-Archive -LiteralPath $zip -DestinationPath $x
      $src = Join-Path $x "worktree-janitor-$Version"
      if (-not (Test-Path -LiteralPath (Join-Path $src 'scripts\janitor.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $src 'scripts\install.mjs'))) { Fail "$asset does not contain worktree-janitor-$Version\scripts\janitor.mjs" }
      [IO.File]::WriteAllText((Join-Path $src '.worktree-janitor-sha256'), "$want`n")
      [IO.File]::WriteAllText((Join-Path $src '.worktree-janitor-install'), "$Marker`n")
      if ($DryRun) {
        Say "  would unpack to $target"
      } else {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        $stage = Join-Path $Dir ".staging.$PID"
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        Copy-Item -LiteralPath $src -Destination $stage -Recurse
        if (Test-Path -LiteralPath $target) {
          if (Test-Link $target) { Fail "$target is a link; not touching it" }
          Remove-Item -LiteralPath $target -Recurse -Force
        }
        Move-Item -LiteralPath $stage -Destination $target
        Say "  unpacked to $target"
        $src = $target
      }
    }

    if ((Test-Path -LiteralPath $Current) -and -not (Test-Link $Current)) { Fail "$Current exists and is not a junction; not touching it" }
    $linkTarget = $null
    if (Test-Link $Current) { $linkTarget = [string](@((Get-Item -LiteralPath $Current -Force).Target)[0]) }
    if ($linkTarget -and ($linkTarget.TrimEnd('\') -ieq $target)) {
      Say "  ok $Current -> $Version"
    } elseif ($DryRun) {
      Say "  would link $Current -> $Version"
    } else {
      if (Test-Link $Current) { Remove-Link $Current }
      New-Item -ItemType Junction -Path $Current -Value $target | Out-Null
      Say "  linked $Current -> $Version"
    }

    foreach ($d in @(Get-ChildItem -LiteralPath $Dir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'v*' -and $_.FullName -ine $target })) {
      if (Test-Link $d.FullName) { continue }
      if (-not (Test-Path -LiteralPath (Join-Path $d.FullName '.worktree-janitor-install'))) { continue }
      Say "  ${pre}remove old version $($d.FullName)"
      if (-not $DryRun) { Remove-Item -LiteralPath $d.FullName -Recurse -Force }
    }

    # Launchers. cmd: the recorded node, else node on PATH.
    $janitor = Join-Path $Current 'scripts\janitor.mjs'
    $cmdText = "@echo off`r`nrem worktree-janitor launcher, $Marker.`r`nrem Remove with: install.ps1 -Uninstall`r`nsetlocal`r`nset `"WJ_NODE=$NodeExe`"`r`nif not exist `"%WJ_NODE%`" set `"WJ_NODE=node`"`r`n`"%WJ_NODE%`" `"$janitor`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    $nodeSh = $NodeExe.Replace('\', '/').Replace("'", "'\''")
    $janSh = $janitor.Replace('\', '/').Replace("'", "'\''")
    $shText = "#!/bin/sh`n# worktree-janitor launcher for Git Bash, $Marker.`nfor n in '$nodeSh' `"`$(command -v node 2>/dev/null)`"; do`n  if [ -n `"`$n`" ] && [ -x `"`$n`" ]; then exec `"`$n`" '$janSh' `"`$@`"; fi`ndone`necho 'worktree-janitor: node not found' >&2`nexit 127`n"
    foreach ($pair in @(@($LauncherCmd, $cmdText), @($LauncherSh, $shText))) {
      $file = $pair[0]; $text = $pair[1]
      if ((Test-Path -LiteralPath $file) -and -not (Test-Ours $file)) { Fail "$file exists and was not installed by worktree-janitor; not overwriting it" }
      if ((Test-Path -LiteralPath $file) -and ([IO.File]::ReadAllText($file) -ceq $text)) { Say "  ok $file"; continue }
      Say "  ${pre}write $file"
      if (-not $DryRun) {
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
        [IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding $false))
      }
    }
    $up = Get-UserPath
    if ($env:WORKTREE_JANITOR_NO_USER_PATH -eq '1') {
      Say "  left the user PATH alone (WORKTREE_JANITOR_NO_USER_PATH=1); add $BinDir yourself"
    } elseif (Test-PathHas $up $BinDir) {
      Say "  ok $BinDir is on the user PATH"
    } else {
      Say "  ${pre}add $BinDir to the user PATH (new terminals pick it up)"
      if (-not $DryRun) { Set-UserPath (Add-PathEntry $up $BinDir) }
    }
    if (-not (Test-PathHas $env:Path $BinDir) -and -not $DryRun) { $env:Path = "$env:Path;$BinDir" }

    $failed = $false
    $extra = @(); if ($DryRun) { $extra += '--dry-run' }
    foreach ($k in @(@('claude', $Claude), @('codex', $Codex))) {
      if (-not $k[1]) { continue }
      if (-not (Invoke-Integration $NodeExe $src $k[0] $extra)) { $failed = $true }
    }
    if (-not $Claude -and -not $Codex) { Say '  no Claude Code / Codex integration (none selected or found on PATH)' }
    if ($failed) { Fail 'an integration step failed (see above)' }
    if ($DryRun) { Say 'Dry run: nothing was changed.' } else { Say 'Done. Open a new terminal and try: worktree-janitor --help' }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-WorktreeJanitor -Version $Version -Dir $Dir -Node $Node -Claude $Claude.IsPresent -Codex $Codex.IsPresent -All $All.IsPresent -None $None.IsPresent -Uninstall $Uninstall.IsPresent -DryRun $DryRun.IsPresent -Help $Help.IsPresent
