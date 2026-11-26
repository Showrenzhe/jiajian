'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { releaseNotes } = require('../scripts/release-notes.cjs');
const { verifyManifest } = require('../scripts/verify-release.cjs');
const yaml = createRequire(require.resolve('electron-updater/package.json'))('js-yaml');

function checkWorkflowReferences(file, source) {
  // js-yaml 的解析结果不含行号。保留每个映射中 uses 键的位置，以便定位块式、行内和锚点写法。
  const usesLines = new WeakMap();
  const nodes = [];
  const workflow = yaml.load(source, {
    filename: file,
    listener(event, state) {
      if (event === 'open') {
        nodes.push({ line: state.line + 1, children: [] });
        return;
      }
      const node = nodes.pop();
      if (state.kind === 'mapping' && Object.hasOwn(state.result, 'uses')) {
        const key = node.children.find((child, index) => index % 2 === 0 && child.value === 'uses');
        if (key) usesLines.set(state.result, key.line);
      }
      nodes.at(-1)?.children.push({ value: state.result, line: node.line });
    },
  });

  const errors = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const entry of [job, ...(job.steps ?? [])]) {
      if (!Object.hasOwn(entry, 'uses')) continue;
      const ref = entry.uses;
      if (typeof ref === 'string') {
        if (ref.startsWith('./')) {
          const [firstDirectory] = path.posix.normalize(ref.replaceAll('\\', '/')).split('/');
          if (firstDirectory !== '..') continue;
        } else if (/^[^@\s]+@[0-9a-f]{40}$/i.test(ref)) {
          continue;
        }
      }
      errors.push(`${file}:${usesLines.get(entry)}  ${String(ref)} 应引用仓库内路径或固定到 40 位提交哈希`);
    }
  }
  return errors;
}

test('所有工作流的外部 Action 和可复用工作流都固定到完整提交', async () => {
  const directory = path.join(__dirname, '../.github/workflows');
  const files = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const errors = [];
  for (const file of files) {
    if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) continue;
    const absolute = path.join(file.parentPath, file.name);
    const display = path.relative(path.join(__dirname, '..'), absolute).split(path.sep).join('/');
    errors.push(...checkWorkflowReferences(display, await fs.readFile(absolute, 'utf8')));
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('未固定的引用报告文件和行号，允许本地引用并忽略脚本字面量', () => {
  const errors = checkWorkflowReferences('example.yaml', [
    'jobs:',
    '  shared: {uses: team/repo/.github/workflows/shared.yml@main}',
    '  check:',
    '    steps:',
    '      - "uses": actions/checkout@v4',
    '      - uses: ./local/action',
    '      - run: |',
    '          uses: example@main',
    '      - uses: ./../outside',
  ].join('\n'));
  assert.deepEqual(errors, [
    'example.yaml:2  team/repo/.github/workflows/shared.yml@main 应引用仓库内路径或固定到 40 位提交哈希',
    'example.yaml:5  actions/checkout@v4 应引用仓库内路径或固定到 40 位提交哈希',
    'example.yaml:9  ./../outside 应引用仓库内路径或固定到 40 位提交哈希',
  ]);
});

test('标签触发 Windows 构建，安装包通过校验后发布到 GitHub 草稿', async () => {
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/release-windows.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.permissions.contents, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /inputs.tag .* github.ref_name/);
  const { steps, env } = workflow.jobs.release;
  assert.equal(env.RELEASE_TAG, '${{ inputs.tag || github.ref_name }}');
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'refs/tags/${{ env.RELEASE_TAG }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const commands = steps.map(step => step.run || '').join('\n');
  const sequence = ['merge-base --is-ancestor', 'npm ci', 'release-notes.cjs', 'prepare-release-tools.ps1',
    'npm test', 'npm run test:updates', './test/release-publish.test.ps1', 'npm run dist:win', 'verify-release.cjs', 'publish-release.ps1 -Tag'];
  let last = -1;
  for (const command of sequence) {
    const current = commands.indexOf(command);
    assert.ok(current > last, command);
    last = current;
  }
  assert.equal(steps.filter(step => step.env?.GH_TOKEN).length, 1);
  assert.equal(steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
  const ci = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.deepEqual(ci.jobs.checks.steps.filter(s => ['npm ci', 'npm test', 'npm run test:smoke'].includes(s.run)).map(s => s.run),
    ['npm ci', 'npm test', 'npm run test:smoke']);
});

test('托管性能检查在同一台机器独立检出两个版本，始终归档各轮证据', async () => {
  const ci = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs.benchmark;
  assert.equal(job.name, 'Windows / 大工程帧间隔');
  assert.equal(job['runs-on'], 'windows-latest');
  assert.deepEqual(job.permissions, { contents: 'read' });
  const steps = job.steps;
  const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkouts.map(step => [step.with.path, step.with.ref, step.with['persist-credentials']]), [
    ['head', '${{ github.sha }}', false], ['base', '${{ steps.baseline.outputs.sha }}', false],
  ]);
  assert.ok(checkouts[0].with['fetch-depth'] >= 2);
  const baseline = steps.find(step => step.id === 'baseline');
  assert.equal(baseline.env.PR_BASE, '${{ github.event.pull_request.base.sha }}');
  assert.equal(baseline.env.PUSH_BEFORE, '${{ github.event.before }}');
  const sample = steps.find(step => step.id === 'sample');
  assert.equal(sample.env.BASE_SHA, '${{ steps.baseline.outputs.sha }}');
  assert.equal(sample.run, './head/scripts/run-paired-bench.ps1');
  assert.ok(steps.some(step => step.run?.includes('compare-bench.cjs --paired $env:REPORTS_DIR')));
  assert.ok(steps.every(step => !step.uses?.startsWith('actions/download-artifact@')));
  assert.equal(steps.at(-1).if, 'always()');
  assert.equal(steps.at(-1).with.path, '${{ env.REPORTS_DIR }}');
});

test('性能基线按事件选取，首次分支推送可用第一父提交，根提交明确失败', { skip: process.platform !== 'win32' }, async t => {
  const ci = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
  const root = await fixture(t);
  const head = path.join(root, 'head');
  await fs.mkdir(head);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: head, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  const commits = [];
  for (let i = 0; i < 3; i++) {
    git('commit', '--allow-empty', '-m', String(i));
    commits.push(git('rev-parse', 'HEAD'));
  }
  const script = path.join(root, 'select.ps1');
  const select = ci.jobs.benchmark.steps.find(step => step.id === 'baseline').run;
  await fs.writeFile(script, "\ufeff$ErrorActionPreference = 'Stop'\n" + select + '\nGet-Content $env:GITHUB_OUTPUT -Tail 1');
  const sample = (event, sha, before) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: root, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_SHA: sha, PR_BASE: commits[0], PUSH_BEFORE: before,
      REPORTS_DIR: path.join(root, 'reports'), GITHUB_OUTPUT: path.join(root, 'output') } }).trim().split(/\r?\n/).at(-1);
  const zero = '0'.repeat(40);
  for (const [event, before, expected] of [
    ['pull_request', zero, commits[0]], ['push', commits[0], commits[0]],
    ['push', zero, commits[1]], ['schedule', zero, commits[1]], ['workflow_dispatch', zero, commits[1]],
  ]) {
    assert.equal(sample(event, commits[2], before), 'sha=' + expected);
  }
  git('checkout', '--detach', commits[0]);
  assert.throws(() => sample('push', commits[0], zero));
  await fs.access(path.join(root, 'reports/baseline-error.txt'));
});

test('内部集显采样只接受启用后的默认分支手动运行', async () => {
  const ci = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
  assert.equal(Object.hasOwn(ci.on, 'pull_request_target'), false);
  const input = ci.on.workflow_dispatch.inputs.integrated_gpu;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);

  const job = ci.jobs['integrated-graphics'];
  assert.deepEqual(job.if.split(/\s*&&\s*/).sort(), [
    "github.event_name == 'workflow_dispatch'",
    "github.ref_type == 'branch'",
    'github.ref_name == github.event.repository.default_branch',
    'inputs.integrated_gpu',
    "vars.INTERNAL_RUNNER_ENABLED == 'true'",
  ].sort());
  assert.deepEqual(job['runs-on'], ['self-hosted', 'Windows', 'integrated-graphics']);
  assert.doesNotMatch(JSON.stringify(job), /\bsecrets\b/i);
  const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkouts.map(step => step.with), [{
    ref: '${{ github.sha }}',
    'persist-credentials': false,
  }]);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('安装包的版本、公开仓库和稳定或预览清单必须对应', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const asar = require('@electron/asar');
  const archive = path.join(root, 'app.asar');
  const { verifyUpdateMode } = require('../scripts/verify-release.cjs');
  const { releaseConfig } = require('../src/update-feed.cjs');
  for (const [version, channel, releaseType] of [
    ['1.0.0', 'latest', 'release'], ['1.0.1-preview.1', 'preview', 'prerelease'],
  ]) {
    const config = { provider: 'github', owner: 'Showrenzhe', repo: 'jiajian', channel, releaseType };
    assert.deepEqual(releaseConfig(version), config);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version }));
    asar.uncache(archive);
    await asar.createPackage(source, archive);
    const file = path.join(root, 'app-update.yml');
    await fs.writeFile(file, JSON.stringify({ ...config, updaterCacheDirName: 'jiajian-updater' }));
    await verifyUpdateMode(root, version);
    await fs.writeFile(file, JSON.stringify({ ...config, repo: 'wrong' }));
    await assert.rejects(verifyUpdateMode(root, version), /官方 GitHub/);
  }
});

test('generate notes from commits since the previous stable tag, or use the edited version', async (t) => {
  const root = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init');
  git('commit', '--allow-empty', '-m', '旧功能');
  git('tag', 'v1.0.0');
  git('commit', '--allow-empty', '-m', '修复导出字幕');
  git('tag', 'v1.0.1-beta.1');
  git('commit', '--allow-empty', '-m', '增加波形预览');
  git('tag', 'v1.0.1');
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.0.1"}');
  assert.equal(releaseNotes(root, 'v1.0.1'), '## 本次更新\n\n- 修复导出字幕\n- 增加波形预览\n');
  await fs.mkdir(path.join(root, 'release-notes'));
  await fs.writeFile(path.join(root, 'release-notes', 'v1.0.1.md'), '人工整理后的说明\n');
  assert.equal(releaseNotes(root, 'v1.0.1'), '人工整理后的说明\n');
  assert.throws(() => releaseNotes(root, 'v1.0.2'), /与 package.json 版本/);
});

test('internal staging verifies immutable installers and publishes the manifest last', async (t) => {
  const root = await fixture(t);
  const artifact = 'Jiajian-Setup-1.0.1-x64.exe';
  const content = Buffer.from('installer');
  const manifest = { version: '1.0.1', files: [{ url: artifact, size: content.length,
    sha512: createHash('sha512').update(content).digest('base64') }], releaseNotes: '新功能' };
  await fs.writeFile(path.join(root, 'latest.yml'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, artifact), content);
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /blockmap/);
  const blockmap = { version: '2', files: [{ offset: 0, sizes: [content.length], checksums: ['test'] }] };
  await fs.writeFile(path.join(root, artifact + '.blockmap'), gzipSync(JSON.stringify(blockmap)));
  await verifyManifest(root, '1.0.1', '新功能');
  const destination = path.join(root,'internal');
  const {stageUpdate} = require('../scripts/stage-update.cjs');
  await stageUpdate(root,destination,'1.0.1','新功能');
  await stageUpdate(root,destination,'1.0.1','新功能');
  await verifyManifest(destination,'1.0.1','新功能');
  blockmap.files[0].sizes = [content.length - 1];
  await fs.writeFile(path.join(root, artifact + '.blockmap'), gzipSync(JSON.stringify(blockmap)));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /差分映射范围/);
  await assert.rejects(verifyManifest(root, '1.0.1', '旧说明'), /说明不一致/);
  await fs.writeFile(path.join(root, artifact), Buffer.alloc(content.length));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /SHA-512/);
});
