# Exercise the draft/publish sequence without contacting GitHub.
$ErrorActionPreference = 'Stop'
$publishScript = (Resolve-Path (Join-Path $PSScriptRoot '../scripts/publish-release.ps1')).Path
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('jiajian-publish-test-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory((Join-Path $sandbox 'dist'))
$state = @{ release = $null; uploads = 0; publications = 0; interrupt = $true; badHash = $false }

function git { return 'fixture-commit' }
function gh {
    switch ($args[0] + ' ' + $args[1]) {
        'api --paginate' {
            if (!$state.release) { return '[[]]' }
            return '[[' + ($state.release | ConvertTo-Json -Depth 5 -Compress) + ']]'
        }
        'release create' {
            if ('--draft' -cnotin $args -or $state.release) { throw 'expected a new draft' }
            $state.release = @{ tag_name = 'v1.0.1'; draft = $true; prerelease = $false; body = '更新'; assets = @() }
        }
        'release upload' {
            if (!$state.release.draft) { throw 'attempted to upload to a public release' }
            $state.uploads++
            $state.release.assets = @(Get-ChildItem 'dist' | ForEach-Object {
                @{ name = $_.Name; state = 'uploaded'; size = $_.Length; digest = 'sha256:' + (Get-FileHash $_.FullName).Hash }
            })
            if ($state.badHash) { $state.release.assets[0].digest = 'sha256:' + ('0' * 64) }
            if ($state.interrupt) { throw 'simulated network failure' }
        }
        'release edit' {
            if ('--draft=false' -cin $args) {
                $state.publications++
                $state.release.draft = $false
            } elseif ('--draft' -cnotin $args) { throw 'unexpected release edit' }
        }
        default { throw "unexpected gh arguments $args" }
    }
}

Push-Location -LiteralPath $sandbox
try {
    Set-Content package.json '{"version":"1.0.1"}'
    Set-Content notes.md '更新'
    'Jiajian-Setup-1.0.1-x64.exe', 'Jiajian-Setup-1.0.1-x64.exe.blockmap', 'latest.yml' |
        ForEach-Object { Set-Content -LiteralPath (Join-Path 'dist' $_) 'fixture' }
    try {
        & $publishScript -Tag 'v1.0.1' -Notes 'notes.md'
        throw 'expected interrupted upload'
    } catch {
        if ($_.Exception.Message -ne 'simulated network failure') { throw }
    }
    if (!$state.release.draft) { throw 'upload failure exposed the draft' }
    $state.interrupt = $false
    $state.badHash = $true
    try {
        & $publishScript -Tag 'v1.0.1' -Notes 'notes.md'
        throw 'expected mismatched checksum'
    } catch {
        if ($_.Exception.Message -notmatch '校验失败') { throw }
    }
    if (!$state.release.draft) { throw 'checksum failure exposed the draft' }
    $state.badHash = $false
    & $publishScript -Tag 'v1.0.1' -Notes 'notes.md'
    & $publishScript -Tag 'v1.0.1' -Notes 'notes.md'
    if ($state.release.draft -or $state.publications -ne 1 -or $state.uploads -ne 3) {
        throw 'expected one publication and no upload on the final rerun'
    }
    Write-Output '发布草稿中断、校验异常、重跑和已发布版本复查均通过。'
} finally {
    Pop-Location
    foreach ($file in 'package.json', 'notes.md', 'dist/latest.yml', 'dist/Jiajian-Setup-1.0.1-x64.exe', 'dist/Jiajian-Setup-1.0.1-x64.exe.blockmap') {
        [IO.File]::Delete((Join-Path $sandbox $file))
    }
    [IO.Directory]::Delete((Join-Path $sandbox 'dist'))
    [IO.Directory]::Delete($sandbox)
}
