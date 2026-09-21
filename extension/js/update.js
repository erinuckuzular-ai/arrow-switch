/*
 * Arrow Switch — updates from inside the panel.
 *
 * The panel asks GitHub for the latest release. If it's newer than this copy, the editor can
 * press Update: the release's signed .zxp is downloaded, unpacked next to this extension,
 * checked, and swapped in. Premiere loads the new version on its next start.
 *
 * Only works when the panel lives somewhere the user can write (the per-user extensions
 * folder, which is where the installer app and install.sh put it). A copy installed for
 * everyone by the .pkg can't replace itself, so the panel links to the download instead.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchUpdate = api;
  else root.ArrowSwitchUpdate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REPO = 'erinuckuzular-ai/arrow-switch';
  var LATEST_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var BUNDLE_ID = 'com.arrow.switch';
  // Downloads must come from this repo's releases, whatever the API says.
  var ALLOWED_DOWNLOAD = new RegExp('^https://github\\.com/' + REPO.replace('/', '\\/') + '/releases/download/');

  // 1.10.0 > 1.9.2; missing parts count as 0; anything after '-' is ignored.
  function compareVersions(a, b) {
    var pa = String(a).replace(/^v/, '').split('-')[0].split('.');
    var pb = String(b).replace(/^v/, '').split('-')[0].split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  // GitHub release JSON -> { version, url, size, page } when it's newer than `current`, else null.
  function newerRelease(release, current) {
    if (!release || release.draft || release.prerelease) return null;
    var version = String(release.tag_name || '').replace(/^v/, '');
    if (!version || compareVersions(version, current) <= 0) return null;
    var zxp = (release.assets || []).filter(function (a) {
      return /\.zxp$/i.test(a.name) && ALLOWED_DOWNLOAD.test(a.browser_download_url || '');
    })[0];
    return {
      version: version,
      url: zxp ? zxp.browser_download_url : null,
      size: zxp ? zxp.size : 0,
      page: release.html_url || 'https://github.com/' + REPO + '/releases/latest'
    };
  }

  // Reads the bundle id and version out of a CSXS/manifest.xml string.
  function readManifest(xml) {
    var id = /ExtensionBundleId="([^"]+)"/.exec(xml);
    var version = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
    return { id: id ? id[1] : null, version: version ? version[1] : null };
  }

  // ---------------------------------------------------------------- Node side (inside Premiere)

  function httpsGet(req, url, headers, redirects) {
    return new Promise(function (resolve, reject) {
      var r = req('https').get(url, { headers: headers }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if ((redirects || 0) > 5) return reject(new Error('Too many redirects.'));
          return resolve(httpsGet(req, res.headers.location, headers, (redirects || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('GitHub answered ' + res.statusCode + '.'));
        }
        resolve(res);
      });
      r.on('error', reject);
      r.setTimeout(30000, function () { r.destroy(new Error('GitHub took too long to answer.')); });
    });
  }

  // Resolves null when up to date, or the newer release (see newerRelease).
  function check(req, current) {
    var headers = { 'User-Agent': 'ArrowSwitch/' + current, Accept: 'application/vnd.github+json' };
    return httpsGet(req, LATEST_API, headers).then(function (res) {
      return new Promise(function (resolve, reject) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          try { resolve(newerRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), current)); } catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
    });
  }

  // Can this copy replace itself? (Not when it was installed for everyone into a system folder.)
  function canSelfUpdate(req, extDir) {
    var fs = req('fs'), path = req('path');
    try {
      fs.accessSync(path.dirname(extDir), fs.constants.W_OK);
      fs.accessSync(extDir, fs.constants.W_OK);
      return true;
    } catch (e) { return false; }
  }

  function unzip(req, zip, dest) {
    var execFile = req('child_process').execFile;
    var win = process.platform === 'win32';
    // Windows 10+ ships bsdtar, which reads zips; macOS has ditto.
    var tool = win ? 'tar' : '/usr/bin/ditto';
    var args = win ? ['-xf', zip, '-C', dest] : ['-x', '-k', zip, dest];
    return new Promise(function (resolve, reject) {
      execFile(tool, args, { timeout: 120000 }, function (err) { if (err) reject(err); else resolve(); });
    });
  }

  /*
   * Downloads `update.url`, unpacks it beside extDir, checks it and swaps it in.
   * onProgress(fraction) is called while downloading. Resolves { version }.
   */
  function install(req, update, extDir, onProgress) {
    var fs = req('fs'), path = req('path'), os = req('os');
    if (!update.url || !ALLOWED_DOWNLOAD.test(update.url)) return Promise.reject(new Error('That release has no panel to download.'));
    var parent = path.dirname(extDir);
    var staging = path.join(parent, BUNDLE_ID + '.update');
    var previous = path.join(parent, BUNDLE_ID + '.previous');
    var zip = path.join(os.tmpdir(), 'arrow-switch-' + update.version + '-' + Date.now() + '.zxp');

    return httpsGet(req, update.url, { 'User-Agent': 'ArrowSwitch-updater' }).then(function (res) {
      return new Promise(function (resolve, reject) {
        var total = Number(res.headers['content-length']) || update.size || 0, got = 0;
        var out = fs.createWriteStream(zip);
        res.on('data', function (c) { got += c.length; if (total && onProgress) onProgress(Math.min(1, got / total)); });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.pipe(out);
      });
    }).then(function () {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      return unzip(req, zip, staging);
    }).then(function () {
      var manifest = readManifest(fs.readFileSync(path.join(staging, 'CSXS', 'manifest.xml'), 'utf8'));
      if (manifest.id !== BUNDLE_ID) throw new Error('The download isn’t an Arrow Switch panel.');
      if (manifest.version !== update.version) throw new Error('Expected version ' + update.version + ' but the download is ' + manifest.version + '.');
      if (!fs.existsSync(path.join(staging, 'META-INF', 'signatures.xml'))) throw new Error('The download isn’t signed.');
      if (process.platform !== 'win32') {
        try { fs.chmodSync(path.join(staging, 'bin', 'ffmpeg'), 0o755); } catch (e) { /* Windows build has no ffmpeg */ }
      }
      // Windows builds don't bundle ffmpeg.exe; keep the one the user put in bin/.
      var oldFfmpeg = path.join(extDir, 'bin', 'ffmpeg.exe');
      if (process.platform === 'win32' && fs.existsSync(oldFfmpeg) && !fs.existsSync(path.join(staging, 'bin', 'ffmpeg.exe'))) {
        fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
        fs.copyFileSync(oldFfmpeg, path.join(staging, 'bin', 'ffmpeg.exe'));
      }
      // Swap: current -> .previous, update -> current. Put the old one back if that fails.
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(extDir, previous);
      try {
        fs.renameSync(staging, extDir);
      } catch (e) {
        fs.renameSync(previous, extDir);
        throw e;
      }
      fs.rmSync(previous, { recursive: true, force: true });
      return { version: update.version };
    }).then(function (done) {
      try { fs.unlinkSync(zip); } catch (e) { /* temp file */ }
      return done;
    }, function (err) {
      try { fs.unlinkSync(zip); } catch (e) { /* temp file */ }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* nothing staged */ }
      throw err;
    });
  }

  return {
    compareVersions: compareVersions,
    newerRelease: newerRelease,
    readManifest: readManifest,
    check: check,
    canSelfUpdate: canSelfUpdate,
    install: install,
    DOWNLOAD_PAGE: 'https://erinuckuzular-ai.github.io/arrow-switch/'
  };
});
