param([Parameter(Mandatory)][ValidateSet('ui','manual')][string]$Mode)
$ErrorActionPreference='Stop'
if ($env:QA_RUNNER_TYPE -ne 'github-hosted' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
$root=Join-Path $env:RUNNER_TEMP ('jiajian-upgrade-'+$Mode)
$null=New-Item -Path $root -ItemType Directory
$updates=@{}
$repository='Showrenzhe/jiajian'
foreach ($version in @('0.8.9','0.9.0')) {
  $json=gh api "repos/$repository/releases/tags/v$version"
  if ($LASTEXITCODE) { throw "Missing release v$version" }
  $release=$json | ConvertFrom-Json
  if ($release.draft -or $release.prerelease -or $release.tag_name -cne "v$version") { throw 'Release is not a public stable tag.' }
  $name="Jiajian-Setup-$version-x64.exe"
  $asset=@($release.assets | Where-Object name -CEQ $name)
  if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw "Missing GitHub digest for $name" }
  $url="https://github.com/$repository/releases/download/v$version/$name"
  if ($asset[0].browser_download_url -cne $url) { throw 'Unexpected release location.' }
  $updates[$version]=@{path=(Join-Path $root $name);sha256=$asset[0].digest.Substring(7);size=$asset[0].size}
  if ($version -eq '0.8.9' -or $Mode -eq 'manual') {
    & curl.exe -fLsS --retry 3 --output $updates[$version].path $url
    if ($LASTEXITCODE) { throw "Download failed: $name" }
    if ((Get-FileHash $updates[$version].path).Hash -ne $updates[$version].sha256 -or
        (Get-Item $updates[$version].path).Length -ne $updates[$version].size) { throw "Asset verification failed: $name" }
  }
}
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
function InstalledEntry {
  @(Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*' -ErrorAction SilentlyContinue |
    Where-Object DisplayName -CEQ '佳剪')
}
function ReadInstall([string]$version) {
  $entry=@(InstalledEntry)
  if ($entry.Count -ne 1 -or $entry[0].DisplayVersion -ne $version) { return }
  if ($entry[0].UninstallString -notmatch '^"([^"]+)"') { throw 'Unexpected uninstall command.' }
  $exe=Join-Path (Split-Path -Parent $Matches[1]) '佳剪.exe'
  if (!(Test-Path -LiteralPath $exe)) { return }
  if ((Get-Item $exe).VersionInfo.ProductVersion -notmatch ('^'+[regex]::Escape($version)+'(\.0)?$')) { return }
  return @{path=$exe;key=$entry[0].PSChildName;version=$entry[0].DisplayVersion}
}
function WaitUntil([scriptblock]$test,[string]$description,[int]$seconds=120) {
  $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
  do {
    $result=& $test
    if ($result) { return $result }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timeout: $description"
}
function SilentInstall($asset) {
  $process=Start-Process -FilePath $asset.path -ArgumentList '/S' -PassThru
  if (!$process.WaitForExit(180000) -or $process.ExitCode -ne 0) { throw 'NSIS silent installation failed.' }
}
function AppWindow($exe) {
  Get-Process -Name '佳剪' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
function Drive([string]$phase,$exe) {
  & node (Join-Path $PSScriptRoot 'installed-ui.cjs') $phase $exe $root $updates['0.9.0'].sha256
  if ($LASTEXITCODE) { throw "Installed UI failed: $phase" }
}
if (@(InstalledEntry).Count -or (Test-Path (Join-Path $env:APPDATA '佳剪/run-data/drafts'))) { throw 'Runner has existing app or draft data.' }
SilentInstall $updates['0.8.9']
$old=WaitUntil { ReadInstall '0.8.9' } 'v0.8.9 registry and installed PE'
Drive $Mode $old.path
if ($Mode -eq 'manual') {
  WaitUntil { -not (AppWindow $old.path) } 'old window closed' | Out-Null
  SilentInstall $updates['0.9.0']
}
$new=WaitUntil { ReadInstall '0.9.0' } 'v0.9.0 registry and installed PE' 180
if ($new.key -cne $old.key -or $new.path -ine $old.path) { throw 'Installer changed registry key or install directory.' }
if ($Mode -eq 'ui') {
  $restarted=WaitUntil { AppWindow $new.path } 'new app automatically restarted'
  if ($restarted.Id -eq [int](Get-Content (Join-Path $root 'old-main.pid'))) { throw 'Old window still present after update.' }
  Write-Host "Updater relaunched $($new.path), PID $($restarted.Id)"
  if (!$restarted.CloseMainWindow() -or !$restarted.WaitForExit(45000)) { throw 'Could not close relaunched app for the independent reopen check.' }
}
Drive 'verify' $new.path
$draft=Get-Content -Raw (Join-Path $root 'verified.json') | ConvertFrom-Json
[PSCustomObject]@{mode=$Mode;from=$old.version;to=$new.version;registry=$new.key;exe=$new.path;oldSHA256=$updates['0.8.9'].sha256;newSHA256=$updates['0.9.0'].sha256;draft=$draft} | ConvertTo-Json -Depth 4
