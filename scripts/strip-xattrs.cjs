const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STAGE_DIR = path.join(os.tmpdir(), 'sohmnamp-arch-bins');

const HELPER_RELS = (baseName) => [
  path.join('Contents', 'MacOS', baseName),
  path.join('Contents', 'Library', 'LoginItems', `${baseName} Login Helper.app`,           'Contents', 'MacOS', `${baseName} Login Helper`),
  path.join('Contents', 'Library', 'LoginItems', `${baseName} Login Helper (GPU).app`,      'Contents', 'MacOS', `${baseName} Login Helper (GPU)`),
  path.join('Contents', 'Library', 'LoginItems', `${baseName} Login Helper (Plugin).app`,   'Contents', 'MacOS', `${baseName} Login Helper (Plugin)`),
  path.join('Contents', 'Library', 'LoginItems', `${baseName} Login Helper (Renderer).app`, 'Contents', 'MacOS', `${baseName} Login Helper (Renderer)`),
];

function run(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); } catch (e) { /* non-fatal */ }
}

function removeSignature(bin) {
  try {
    execSync(`codesign --remove-signature "${bin}"`, { stdio: 'pipe' });
  } catch (e) { /* already unsigned, fine */ }
}

exports.default = async ({ appOutDir, arch }) => {
  const archName = { 1: 'x64', 2: 'ia32', 3: 'arm64', 4: 'universal' }[arch] || String(arch);
  console.log(`\n🧹 strip-xattrs (arch: ${archName})`);

  run(`xattr -cr "${appOutDir}"`);

  const appName = fs.readdirSync(appOutDir).find(f => f.endsWith('.app'));
  if (!appName) { console.warn('⚠️  No .app found.'); return; }
  const baseName = appName.replace('.app', '');

  // x64/arm64: save clean copies of each arch binary (strip adhoc sig first)
  if (arch === 1 || arch === 3) {
    const archDir = path.join(STAGE_DIR, archName);
    fs.mkdirSync(archDir, { recursive: true });

    for (const rel of HELPER_RELS(baseName)) {
      const src = path.join(appOutDir, appName, rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(archDir, path.basename(src));
      fs.copyFileSync(src, dest);
      removeSignature(dest);  // strip adhoc before staging
      console.log(`  💾 saved ${archName}: ${path.basename(src)}`);
    }
    console.log('✅ Done.\n');
    return;
  }

  // universal: re-merge with clean unsigned arch binaries, then strip result too
  if (arch === 4) {
    const x64Dir   = path.join(STAGE_DIR, 'x64');
    const arm64Dir  = path.join(STAGE_DIR, 'arm64');

    if (!fs.existsSync(x64Dir) || !fs.existsSync(arm64Dir)) {
      console.warn('⚠️  Staged arch bins not found, skipping lipo re-merge.');
      console.log('✅ Done.\n');
      return;
    }

    console.log('🔧 lipo re-merging clean unsigned arch binaries...');
    for (const rel of HELPER_RELS(baseName)) {
      const unibin   = path.join(appOutDir, appName, rel);
      const binName  = path.basename(rel);
      const x64bin   = path.join(x64Dir,   binName);
      const arm64bin  = path.join(arm64Dir, binName);

      if (!fs.existsSync(unibin) || !fs.existsSync(x64bin) || !fs.existsSync(arm64bin)) continue;

      const tmp = unibin + '.__lipo__';
      try {
        execSync(`lipo -create "${x64bin}" "${arm64bin}" -output "${tmp}"`, { stdio: 'pipe' });
        removeSignature(tmp);  // strip any adhoc from the merged result
        fs.renameSync(tmp, unibin);
        fs.chmodSync(unibin, 0o755);
        console.log(`  ✓ ${binName}`);
      } catch (e) {
        console.warn(`  ⚠️  lipo failed for ${binName}: ${e.message}`);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    }

    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
    run(`xattr -cr "${appOutDir}"`);
    console.log('✅ Done.\n');
  }
};
