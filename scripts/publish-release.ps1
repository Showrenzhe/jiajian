[CmdletBinding()]
param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][string]$Notes)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$version = (Get-Content -Raw -Encoding utf8 'package.json' | ConvertFrom-Json).version
if ($Tag -cnotmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$' -or $Tag -cne "v$version") { throw '版本或标签不符。' }
$headCommit = git rev-parse HEAD
$tagCommit = git rev-parse "refs/tags/$Tag^{commit}"
if ($headCommit -cne $tagCommit) { throw '发布工作树与标签提交不一致。' }
$body = (Get-Content -Raw -Encoding utf8 -LiteralPath $Notes).Replace("`r`n","`n").Trim()
if (!$body) { throw '更新说明为空。' }
$setup = "Jiajian-Setup-$version-x64.exe"
$preview = $version.Contains('-preview.')
$manifest = if ($preview) { 'preview.yml' } else { 'latest.yml' }
$releaseFlag = if ($preview) { '--prerelease' } else { '--prerelease=false' }
$latestFlag = if ($preview) { '--latest=false' } else { '--latest' }
$names = @($setup, "$setup.blockmap", $manifest)
$assets = @($names | ForEach-Object { (Get-Item -LiteralPath (Join-Path 'dist' $_)).FullName })

function Get-Release {
    # The authenticated list includes drafts left by an interrupted upload.
    $pages = gh api --paginate --slurp 'repos/{owner}/{repo}/releases?per_page=100' | ConvertFrom-Json
    foreach ($page in $pages) {
        foreach ($release in $page) {
            if ($release.tag_name -ceq $Tag) { return $release }
        }
    }
}

function Assert-KnownAssets($release) {
    if (@($release.assets | Where-Object { $_.name -cnotin $names }).Count) {
        throw 'GitHub 发布记录包含额外附件，请先核对。'
    }
}

function Assert-Assets($release, [switch]$CheckLocalHash) {
    Assert-KnownAssets $release
    if ([bool]$release.prerelease -ne $preview) { throw 'GitHub 发布通道与标签不一致。' }
    foreach ($name in $names) {
        $found = @($release.assets | Where-Object { $_.name -ceq $name })
        if ($found.Count -ne 1 -or $found[0].state -ne 'uploaded' -or $found[0].size -le 0 -or
            $found[0].digest -notmatch '^sha256:[0-9a-f]{64}$') {
            throw "GitHub 上的 $name 尚未完整上传。"
        }
        if ($CheckLocalHash) {
            $local = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path 'dist' $name)
            if ($found[0].digest -ne ('sha256:' + $local.Hash)) { throw "GitHub 上的 $name 校验失败。" }
        }
    }
    if ($release.body.Replace("`r`n","`n").Trim() -cne $body) { throw '发布正文与应用说明不一致。' }
}

$release = Get-Release
if ($release -and !$release.draft) {
    Assert-Assets $release
    Write-Output "$Tag 已发布，已复核附件及更新说明。"
    return
}

if ($release) {
    Assert-KnownAssets $release
    gh release edit $Tag --draft $releaseFlag --title "佳剪 $Tag" --notes-file $Notes
} else {
    gh release create $Tag --verify-tag --draft $releaseFlag --title "佳剪 $Tag" --notes-file $Notes
}
gh release upload $Tag @assets --clobber
$staged = Get-Release
if (!$staged -or !$staged.draft) { throw '未找到待校验的发布草稿。' }
Assert-Assets $staged -CheckLocalHash
gh release edit $Tag --draft=false $releaseFlag $latestFlag
