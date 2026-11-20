$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & cmd.exe /d /c scripts\build-thumbnail.cmd test
    if ($LASTEXITCODE) { throw 'Windows 缩略图组件编译失败。' }
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('jiajian-thumbnail-' + [guid]::NewGuid())
    [void][IO.Directory]::CreateDirectory($dir)
    $jpeg = Join-Path $dir 'red.jpg'
    $project = Join-Path $dir '测试.sdworkbench'
    try {
        & '.\tools\ffmpeg-8.0-full_build\bin\ffmpeg.exe' -v error -f lavfi -i 'color=red:size=128x64' -frames:v 1 $jpeg
        if ($LASTEXITCODE) { throw '生成测试帧失败。' }
        $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($jpeg))
        [IO.File]::WriteAllText($project, '{"thumbnail":"data:image/jpeg;base64,' + $base64 + '"}')
        & '.\tools\project-thumbnail\verify.exe' $project
        if ($LASTEXITCODE) { throw '未从工程读取到预期的红色缩略图。' }
        [IO.File]::WriteAllText($project, '{"thumbnail":"data:image/jpeg;base64,broken"}')
        & '.\tools\project-thumbnail\verify.exe' $project
        if ($LASTEXITCODE -ne 5) { throw '损坏的 JPEG 应返回无缩略图。' }
        $global:LASTEXITCODE = 0
    } finally {
        foreach ($file in $jpeg, $project) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
        [IO.Directory]::Delete($dir)
    }
} finally { Pop-Location }
