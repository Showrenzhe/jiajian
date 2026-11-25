$ErrorActionPreference = 'Stop'
node --test --test-name-pattern 'internal staging' "$PSScriptRoot/release-workflow.test.cjs"
if ($LASTEXITCODE) { throw '内部更新目录测试失败。' }
