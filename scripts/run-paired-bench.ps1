# 工作区的 head 与 base 已分别检出到固定提交。每次启动由采样驱动创建独立的 Electron 会话和临时工程。
$ErrorActionPreference = 'Stop'
$workspace = (Get-Location).Path
$reports = (Resolve-Path -LiteralPath $env:REPORTS_DIR).Path
$order = @('base-1', 'head-1', 'head-2', 'base-2')
# 这两个测试辅助文件提供真实输入与媒体夹具，与测量驱动一并使用候选版本。
$driverFiles = @('test/run-interaction-frames.cjs', 'test/interaction-frames-desktop.cjs', 'test/fixtures.cjs', 'test/desktop-input.cjs')
$provenance = [ordered]@{
    order = $order
    image = $env:ImageOS
    imageVersion = $env:ImageVersion
    revisions = [ordered]@{}
    rounds = [ordered]@{}
}

foreach ($side in 'head', 'base') {
    Push-Location (Join-Path $workspace $side)
    try {
        $commit = git rev-parse HEAD
        $expected = if ($side -eq 'base') { $env:BASE_SHA } else { $env:GITHUB_SHA }
        if ($LASTEXITCODE -or $commit -ne $expected) { throw "$side 检出提交与预期不符" }
        $sourceTree = git rev-parse HEAD:src
        if ($LASTEXITCODE) { throw "$side 无法读取应用源码树" }
        npm ci
        if ($LASTEXITCODE) { throw "$side 安装依赖失败" }
        ./scripts/prepare-release-tools.ps1

        $hashes = [ordered]@{}
        foreach ($file in $driverFiles) {
            if ($side -eq 'base') { Copy-Item -LiteralPath (Join-Path "$workspace/head" $file) -Destination $file }
            $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash
        }
        foreach ($file in 'package-lock.json', 'tools/ffmpeg-8.0-full_build/bin/ffmpeg.exe', 'tools/ffmpeg-8.0-full_build/bin/ffprobe.exe') {
            $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash
        }
        $provenance.revisions[$side] = @{ commit = $commit; sourceTree = $sourceTree; sha256 = $hashes }
        $provenance | ConvertTo-Json -Depth 6 > "$reports/provenance.json"
    } finally { Pop-Location }
}

$failed = @()
foreach ($round in $order) {
    $side = $round.Split('-')[0]
    $reportPath = Join-Path $reports "$round.json"
    Push-Location (Join-Path $workspace $side)
    try {
        Write-Host "::group::$round"
        $bin = (Resolve-Path 'tools/ffmpeg-8.0-full_build/bin').Path
        $env:JIAJIAN_FFMPEG = Join-Path $bin 'ffmpeg.exe'
        $env:JIAJIAN_FFPROBE = Join-Path $bin 'ffprobe.exe'
        $env:JIAJIAN_BENCH_REPORT = $reportPath
        node test/run-interaction-frames.cjs --large --paired 2>&1 | Tee-Object "$reports/$round.log"
        if ($LASTEXITCODE -or !(Test-Path -LiteralPath $env:JIAJIAN_BENCH_REPORT)) { throw '采样失败或报告缺失' }
        $report = Get-Content -LiteralPath $env:JIAJIAN_BENCH_REPORT -Raw | ConvertFrom-Json
        $driverHash = $provenance.revisions[$side].sha256['test/interaction-frames-desktop.cjs']
        if ($report.environment.driverSha256 -ne $driverHash) { throw '报告里的采样驱动哈希与实际文件不同' }
        $provenance.rounds[$round] = @{ sourceSha256 = $report.environment.sourceSha256; driverSha256 = $driverHash }
    } catch {
        $failed += $round
        $provenance.rounds[$round] = @{ error = $_.Exception.Message }
        Write-Warning "$round $_"
        # 即使驱动先写出报告再失败，也保留原始数据，并让比较器明确报缺少有效轮次。
        if (Test-Path -LiteralPath $reportPath) { Rename-Item -LiteralPath $reportPath -NewName "$round.failed.json" }
    } finally {
        Pop-Location
        Write-Host '::endgroup::'
        $provenance | ConvertTo-Json -Depth 6 > "$reports/provenance.json"
    }
}
if ($failed.Count) { throw "未能完成全部有效采样：$failed" }
