const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appPath = process.argv[2] || path.join('dist', 'mas-universal', 'SOHMNAMP.app');
const teamId = '5S2MSRJ378';
const bundleId = 'com.sohmna.sohmnamp';
const appGroup = `${teamId}.${bundleId}`;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function inspectEntitlements(targetPath) {
  const result = spawnSync('codesign', ['-d', '--entitlements', '-', targetPath], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(appPath)) {
  fail(`Missing app bundle: ${appPath}`);
  process.exit();
}

const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
let electronTeamId = '';
try {
  electronTeamId = run('plutil', ['-extract', 'ElectronTeamID', 'raw', infoPlist]).trim();
} catch (_) {
  electronTeamId = '';
}
if (electronTeamId !== teamId) {
  fail(`ElectronTeamID is ${electronTeamId || '(missing)'}, expected ${teamId}`);
}

const appEntitlements = inspectEntitlements(appPath);

if (/invalid entitlements blob/i.test(appEntitlements)) {
  fail('Main app has an invalid entitlements blob');
}
if (!appEntitlements.includes('com.apple.security.app-sandbox')) {
  fail('Main app is missing com.apple.security.app-sandbox');
}
if (!appEntitlements.includes(appGroup)) {
  fail(`Main app is missing application group ${appGroup}`);
}
if (!appEntitlements.includes('com.apple.security.cs.allow-jit')) {
  fail('Main app is missing com.apple.security.cs.allow-jit');
}
if (!appEntitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory')) {
  fail('Main app is missing com.apple.security.cs.allow-unsigned-executable-memory');
}

const helperNames = [
  'SOHMNAMP Helper.app',
  'SOHMNAMP Helper (Renderer).app',
  'SOHMNAMP Helper (GPU).app',
  'SOHMNAMP Helper (Plugin).app',
];

for (const name of helperNames) {
  const helperPath = path.join(appPath, 'Contents', 'Frameworks', name);
  if (!fs.existsSync(helperPath)) {
    fail(`Missing helper bundle: ${name}`);
    continue;
  }

  const helperEntitlements = inspectEntitlements(helperPath);

  if (/invalid entitlements blob/i.test(helperEntitlements)) {
    fail(`${name} has an invalid entitlements blob`);
  }
  if (!helperEntitlements.includes('com.apple.security.inherit')) {
    fail(`${name} is missing com.apple.security.inherit`);
  }
  if (!helperEntitlements.includes('com.apple.security.cs.allow-jit')) {
    fail(`${name} is missing com.apple.security.cs.allow-jit`);
  }
  if (!helperEntitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory')) {
    fail(`${name} is missing com.apple.security.cs.allow-unsigned-executable-memory`);
  }
}

if (!process.exitCode) {
  console.log(`OK MAS bundle looks launch-safe: ${appPath}`);
}
