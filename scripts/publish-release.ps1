[CmdletBinding()]
param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][string]$Notes)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$version = (Get-Content -Raw -Encoding utf8 'package.json' | ConvertFrom-Json).version
if ($Tag -cnotmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $Tag -cne "v$version") { throw '版本或标签不符。' }
$headCommit = git rev-parse HEAD
$tagCommit = git rev-parse "refs/tags/$Tag^{commit}"
if ($headCommit -cne $tagCommit) { throw '发布工作树与标签提交不一致。' }
$body = (Get-Content -Raw -Encoding utf8 -LiteralPath $Notes).Replace("`r`n","`n").Trim()
if (!$body) { throw '更新说明为空。' }
$setup = "Jiajian-Setup-$version-x64.exe"
$names = @($setup, "$setup.blockmap", 'latest.yml')
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

function Assert-Assets($release, [switch]$CheckLocalHash) {
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
    if ($release.prerelease) { throw '此标签已有预发行版本。' }
    Assert-Assets $release
    Write-Output "$Tag 的正式版已发布。"
    return
}

if ($release) {
    if (@($release.assets | Where-Object { $_.name -cnotin $names }).Count) {
        throw '已有草稿包含额外附件，请先核对草稿。'
    }
    gh release edit $Tag --draft --prerelease=false --title "佳剪 $Tag" --notes-file $Notes
} else {
    gh release create $Tag --verify-tag --draft --title "佳剪 $Tag" --notes-file $Notes
}
gh release upload $Tag @assets --clobber
$staged = Get-Release
if (!$staged -or !$staged.draft) { throw '未找到待校验的发布草稿。' }
Assert-Assets $staged -CheckLocalHash
gh release edit $Tag --draft=false --verify-tag
