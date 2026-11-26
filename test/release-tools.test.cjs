'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const prepare = path.resolve(__dirname, '../scripts/prepare-release-tools.ps1');
const githubToken = 'github-unit-fixture';
const mirrorToken = 'mirror-unit-fixture';
const signature = 'signed-unit-fixture';

async function shell(command, env) {
  const setup = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n";
  return run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', setup + command], {
    env: { ...process.env, GH_TOKEN: '', JIAJIAN_TOOLS_TOKEN: '', JIAJIAN_TOOLS_URL: '', ...env },
    windowsHide: true, timeout: 30000,
  });
}

test('工具包下载按来源授权、跳转时保护令牌并脱敏报告 HTTP 错误', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-tool-request-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cert = await shell([
    "$key = [Security.Cryptography.RSA]::Create(2048)",
    "$req = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()",
    "'github.com','api.github.com','delivery.invalid','mirror.invalid','github.com.mirror.invalid' | ForEach-Object { $san.AddDnsName($_) }",
    "$req.CertificateExtensions.Add($san.Build())",
    "$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))",
    "[IO.File]::WriteAllText($env:TEST_CERT, $cert.ExportCertificatePem())",
    "[Convert]::ToBase64String($cert.Export('Pfx', 'fixture'))",
  ].join('\n'), { TEST_CERT: path.join(temp, 'certificate.pem') });

  const requests = [];
  const server = https.createServer({ pfx: Buffer.from(cert.stdout.trim(), 'base64'), passphrase: 'fixture' }, (req, res) => {
    requests.push({ origin: req.headers.host, url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: 'https://delivery.invalid/denied?token=' + signature });
    } else if (req.url === '/bad.zip') {
      res.writeHead(200);
      res.write('wrong archive');
    } else {
      res.writeHead(403);
      res.write('HTTP error detail containing ' + signature);
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function download(url, token = '', ghToken = githubToken) {
    requests.length = 0;
    // Route every host to the fixture. TLS uses its ephemeral, uninstalled certificate.
    const command = [
      '$binary = (Get-Command curl.exe -CommandType Application).Source',
      'function curl.exe {',
      '  $input | & $binary --disable --noproxy "*" --connect-to $env:TEST_ROUTE --cacert $env:TEST_CERT @args',
      '  $global:LASTEXITCODE = $LASTEXITCODE',
      '}',
      '& $env:TEST_SCRIPT -ToolsDirectory $env:TEST_TOOLS',
    ].join('\n');
    let result;
    try {
      await shell(command, {
        TEST_ROUTE: '::127.0.0.1:' + server.address().port, TEST_SCRIPT: prepare,
        TEST_TOOLS: path.join(temp, 'tools'), TEST_CERT: path.join(temp, 'certificate.pem'),
        JIAJIAN_TOOLS_URL: url, GH_TOKEN: ghToken, JIAJIAN_TOOLS_TOKEN: token,
      });
    } catch (error) {
      result = error;
    }
    assert.equal(result?.code, 1);
    const output = result.stdout + result.stderr;
    for (const secret of [githubToken, mirrorToken, signature]) assert.ok(!output.includes(secret));
    return output;
  }

  assert.match(await download('https://api.github.com/redirect?token=' + signature), /HTTP 403/);
  assert.deepEqual(requests.map(req => req.auth), ['Bearer ' + githubToken, undefined]);
  assert.deepEqual(requests.map(req => req.origin), ['api.github.com', 'delivery.invalid']);
  assert.equal(requests[0].accept, 'application/octet-stream');
  const denied = await download('https://mirror.invalid/private?sig=' + signature, mirrorToken);
  assert.ok(denied.includes('https://mirror.invalid') && denied.includes('HTTP 403') && denied.includes('若仓库已转私有'));
  assert.ok(!denied.includes('/private'));
  assert.equal(requests[0].auth, 'Bearer ' + mirrorToken);
  await download('https://github.com.mirror.invalid/denied');
  assert.equal(requests[0].auth, undefined);
  await download('https://github.com:444/denied');
  assert.equal(requests[0].auth, undefined);
  await download('', '', '');
  assert.equal(requests[0].origin, 'github.com');
  assert.equal(requests[0].url, '/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-full_build.zip');
  assert.equal(requests[0].auth, undefined);
  const wrongHash = await download('https://github.com/bad.zip');
  assert.equal(requests[0].auth, 'Bearer ' + githubToken);
  assert.match(wrongHash, /SHA-256/);
  assert.deepEqual(await fs.readdir(temp), ['certificate.pem']);
});

test('四个提取文件各自校验 SHA-256，已校验的工具支持离线复用', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-tool-hashes-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const archive = path.join(temp, 'tools.zip');
  const fixture = path.join(temp, 'prepare.ps1');
  const env = { TEST_SCRIPT: fixture, TEST_SOURCE: source, TEST_ZIP: archive, TEST_TOOLS: path.join(temp, 'tools'),
    JIAJIAN_TOOLS_URL: 'invalid-offline-url' };
  const names = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'];
  let script = await fs.readFile(prepare, 'utf8');
  const digest = data => createHash('sha256').update(data).digest('hex');
  await fs.mkdir(path.join(source, 'ffmpeg-8.0-full_build', 'bin'), { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(source, 'ffmpeg-8.0-full_build', name), name);
    const pin = new RegExp("('" + name.replaceAll('.', '\\.') + "' = ')[0-9a-f]{64}");
    script = script.replace(pin, (_, prefix) => prefix + digest(name));
  }
  await shell('[IO.Compression.ZipFile]::CreateFromDirectory($env:TEST_SOURCE, $env:TEST_ZIP)', env);
  const archiveHash = digest(await fs.readFile(archive));
  script = script.replace(/(\$archiveHash = ')[0-9a-f]{64}/, (_, prefix) => prefix + archiveHash);
  await fs.writeFile(fixture, script);
  const extract = '& $env:TEST_SCRIPT -Archive $env:TEST_ZIP -ToolsDirectory $env:TEST_TOOLS';
  await shell(extract, env);
  await shell('& $env:TEST_SCRIPT -ToolsDirectory $env:TEST_TOOLS', env);
  for (const name of names) {
    assert.equal(await fs.readFile(path.join(env.TEST_TOOLS, name), 'utf8'), name);
    await fs.writeFile(fixture, script.replace(digest(name), '0'.repeat(64)));
    await assert.rejects(shell(extract, env), e => e.code === 1 && e.stderr.includes('校验失败'));
  }
});
