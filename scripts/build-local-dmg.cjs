const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const builderBin = path.join(
  projectDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);

const localArch = process.env.SOHMNAMP_LOCAL_ARCH || process.arch;
const archFlag = localArch === 'x64' ? '--x64' : '--arm64';

const args = [
  '--projectDir', projectDir,
  '--mac',
  archFlag,
  '--config.mac.target=dmg',
  '--config.mac.identity=-',
  '--config.dmg.sign=false',
  `--config.afterPack=${path.join(projectDir, 'scripts', 'strip-xattrs.cjs')}`,
  `--config.mac.entitlements=${path.join(projectDir, 'entitlements.mac.plist')}`,
  `--config.mac.entitlementsInherit=${path.join(projectDir, 'entitlements.mac.inherit.plist')}`,
];

const child = spawn(builderBin, args, {
  cwd: os.tmpdir(),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
