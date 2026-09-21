const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('../extension/js/update.js');

const DL = 'https://github.com/erinuckuzular-ai/arrow-switch/releases/download/';
const release = (tag, assets, extra) => Object.assign({ tag_name: tag, html_url: 'page', assets: assets || [] }, extra);

test('compares versions part by part', () => {
  assert.strictEqual(U.compareVersions('1.10.0', '1.9.2'), 1);
  assert.strictEqual(U.compareVersions('v1.6.0', '1.6'), 0);
  assert.strictEqual(U.compareVersions('1.6.0', '1.6.1'), -1);
  assert.strictEqual(U.compareVersions('2.0.0-beta', '2.0.0'), 0);
});

test('offers only newer, published releases with a .zxp from this repo', () => {
  const zxp = { name: 'Arrow-Switch-1.7.0.zxp', size: 5, browser_download_url: DL + 'v1.7.0/Arrow-Switch-1.7.0.zxp' };
  assert.deepStrictEqual(U.newerRelease(release('v1.7.0', [zxp]), '1.6.0'),
    { version: '1.7.0', url: zxp.browser_download_url, size: 5, page: 'page' });
  assert.strictEqual(U.newerRelease(release('v1.6.0', [zxp]), '1.6.0'), null);
  assert.strictEqual(U.newerRelease(release('v1.7.0', [zxp], { prerelease: true }), '1.6.0'), null);
  assert.strictEqual(U.newerRelease(release('v1.7.0', [zxp], { draft: true }), '1.6.0'), null);
  // A .zxp hosted anywhere else is ignored.
  const foreign = { name: 'x.zxp', browser_download_url: 'https://evil.example/x.zxp' };
  assert.strictEqual(U.newerRelease(release('v1.7.0', [foreign]), '1.6.0').url, null);
});

test('reads the bundle id and version from a manifest', () => {
  assert.deepStrictEqual(U.readManifest('<ExtensionManifest ExtensionBundleId="com.arrow.switch" ExtensionBundleVersion="1.6.1">'),
    { id: 'com.arrow.switch', version: '1.6.1' });
});

test('refuses downloads that are not this repo\'s releases', async () => {
  await assert.rejects(U.install(require, { version: '9.0.0', url: 'https://evil.example/x.zxp' }, '/tmp/nowhere'), /no panel/);
});

test('swaps a downloaded panel in place of the installed one', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-upd-'));
  const ext = path.join(dir, 'com.arrow.switch');
  fs.mkdirSync(path.join(ext, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'CSXS/manifest.xml'), 'ExtensionBundleId="com.arrow.switch" ExtensionBundleVersion="1.6.0"');
  // Build a fake signed .zxp for 1.7.0 and serve it through a stubbed https module.
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'CSXS'), { recursive: true });
  fs.mkdirSync(path.join(src, 'META-INF'));
  fs.writeFileSync(path.join(src, 'CSXS/manifest.xml'), 'ExtensionBundleId="com.arrow.switch" ExtensionBundleVersion="1.7.0"');
  fs.writeFileSync(path.join(src, 'META-INF/signatures.xml'), '<sig/>');
  const zxp = path.join(dir, 'new.zxp');
  execFileSync('/usr/bin/ditto', ['-c', '-k', src, zxp]);
  const { PassThrough } = require('stream');
  const stubReq = (name) => name === 'https' ? {
    get(url, opts, cb) {
      const res = new PassThrough();
      res.statusCode = 200; res.headers = { 'content-length': String(fs.statSync(zxp).size) };
      setImmediate(() => { cb(res); res.end(fs.readFileSync(zxp)); });
      return { on() {}, setTimeout() {} };
    }
  } : require(name);
  let progress = 0;
  const done = await U.install(stubReq, { version: '1.7.0', url: DL + 'v1.7.0/Arrow-Switch-1.7.0.zxp' }, ext, (f) => { progress = f; });
  assert.strictEqual(done.version, '1.7.0');
  assert.strictEqual(progress, 1);
  assert.match(fs.readFileSync(path.join(ext, 'CSXS/manifest.xml'), 'utf8'), /1\.7\.0/);
  assert.ok(!fs.existsSync(path.join(dir, 'com.arrow.switch.update')));
  assert.ok(!fs.existsSync(path.join(dir, 'com.arrow.switch.previous')));
});

test('keeps the installed panel when the download is the wrong version', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-upd-'));
  const ext = path.join(dir, 'com.arrow.switch');
  fs.mkdirSync(path.join(ext, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'CSXS/manifest.xml'), 'ExtensionBundleId="com.arrow.switch" ExtensionBundleVersion="1.6.0"');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(src, 'CSXS/manifest.xml'), 'ExtensionBundleId="com.arrow.switch" ExtensionBundleVersion="1.5.0"');
  const zxp = path.join(dir, 'old.zxp');
  execFileSync('/usr/bin/ditto', ['-c', '-k', src, zxp]);
  const { PassThrough } = require('stream');
  const stubReq = (name) => name === 'https' ? {
    get(url, opts, cb) { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; setImmediate(() => { cb(res); res.end(fs.readFileSync(zxp)); }); return { on() {}, setTimeout() {} }; }
  } : require(name);
  await assert.rejects(U.install(stubReq, { version: '1.7.0', url: DL + 'v1.7.0/a.zxp' }, ext), /Expected version 1\.7\.0/);
  assert.match(fs.readFileSync(path.join(ext, 'CSXS/manifest.xml'), 'utf8'), /1\.6\.0/);
  assert.ok(!fs.existsSync(path.join(dir, 'com.arrow.switch.update')));
});
