# Exercise the GitHub CLI calls with a local release fixture.
$ErrorActionPreference = 'Stop'
$publishScript = (Resolve-Path (Join-Path $PSScriptRoot '../scripts/publish-release.ps1')).Path
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('jiajian-publish-test-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory((Join-Path $sandbox 'dist'))

function git { return 'fixture-commit' }
function gh {
    switch ($args[0] + ' ' + $args[1]) {
        'api --paginate' {
            if (!$state.release) { return '[[]]' }
            return '[[' + ($state.release | ConvertTo-Json -Depth 5 -Compress) + ']]'
        }
        'release create' {
            if ('--draft' -cnotin $args -or '--verify-tag' -cnotin $args -or $state.release) { throw 'expected a new draft for an existing tag' }
            $state.release = @{ tag_name = $args[2]; draft = $true; prerelease = ('--prerelease' -cin $args); body = '更新'; assets = @() }
        }
        'release upload' {
            if (!$state.release.draft) { throw 'attempted to upload to a public release' }
            $files = @($args[3..($args.Count - 1)] | Where-Object { $_ -ne '--clobber' } | ForEach-Object { Get-Item -LiteralPath $_ })
            if (Compare-Object $expected $files.Name -CaseSensitive) { throw 'wrong files supplied to GitHub' }
            $state.uploads++
            $state.release.assets = @($files | ForEach-Object {
                @{ name = $_.Name; state = 'uploaded'; size = $_.Length; digest = 'sha256:' + (Get-FileHash $_.FullName).Hash }
            })
            if ($state.badHash) { $state.release.assets[0].digest = 'sha256:' + ('0' * 64) }
            if ($state.interrupt) { throw 'simulated network failure' }
        }
        'release edit' {
            if ('--draft=false' -cin $args) {
                $flag = if ($state.preview) { '--latest=false' } else { '--latest' }
                if ($flag -cnotin $args) { throw 'latest marker does not match channel' }
                $state.publications++
                $state.release.draft = $false
            } elseif ('--draft' -cnotin $args) { throw 'unexpected release edit' }
            $state.release.prerelease = '--prerelease' -cin $args
        }
        default { throw "unexpected gh arguments $args" }
    }
}

Push-Location -LiteralPath $sandbox
try {
    Set-Content notes.md '更新'
    Set-Content dist/private-project.jiajian 'fixture must remain local'
    foreach ($version in '1.0.1', '1.0.2-preview.1') {
        $tag = "v$version"
        $state = @{ release = $null; uploads = 0; publications = 0; interrupt = $true; badHash = $false; preview = $version.Contains('-') }
        $manifest = if ($state.preview) { 'preview.yml' } else { 'latest.yml' }
        $setup = "Jiajian-Setup-$version-x64.exe"
        $expected = @($setup, "$setup.blockmap", $manifest)
        Set-Content package.json (@{ version = $version } | ConvertTo-Json)
        foreach ($name in $expected) { Set-Content -LiteralPath (Join-Path 'dist' $name) 'fixture' }
        try {
            & $publishScript -Tag $tag -Notes 'notes.md'
            throw 'expected interrupted upload'
        } catch {
            if ($_.Exception.Message -ne 'simulated network failure') { throw }
        }
        if (!$state.release.draft) { throw 'upload failure exposed the draft' }
        $previousAssets = $state.release.assets
        $state.release.assets += @{ name = 'private-project.jiajian' }
        try {
            & $publishScript -Tag $tag -Notes 'notes.md'
            throw 'expected unknown asset rejection'
        } catch {
            if ($_.Exception.Message -notmatch '额外附件') { throw }
        }
        $state.release.assets = $previousAssets
        $state.interrupt = $false
        $state.badHash = $true
        try {
            & $publishScript -Tag $tag -Notes 'notes.md'
            throw 'expected mismatched checksum'
        } catch {
            if ($_.Exception.Message -notmatch '校验失败') { throw }
        }
        if (!$state.release.draft) { throw 'checksum failure exposed the draft' }
        $state.badHash = $false
        & $publishScript -Tag $tag -Notes 'notes.md'
        & $publishScript -Tag $tag -Notes 'notes.md'
        if ($state.release.draft -or $state.release.prerelease -ne $state.preview -or $state.publications -ne 1 -or $state.uploads -ne 3) {
            throw 'expected one publication for the correct channel and no upload on rerun'
        }
    }
    Write-Output '稳定版与预览版的附件白名单、中断恢复、校验异常、通道标记及重跑通过。'
} finally {
    Pop-Location
    foreach ($file in [IO.Directory]::GetFiles((Join-Path $sandbox 'dist'))) { [IO.File]::Delete($file) }
    foreach ($name in 'package.json', 'notes.md') { [IO.File]::Delete((Join-Path $sandbox $name)) }
    [IO.Directory]::Delete((Join-Path $sandbox 'dist'))
    [IO.Directory]::Delete($sandbox)
}
