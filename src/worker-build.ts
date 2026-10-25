#!/usr/bin/env bun
/**
 * Runs on the devbox worker, in the project directory. Builds the iOS app with
 * Xcode, installs it on the devbox simulator, launches it, and prints its logs.
 * Exits non-zero when the build fails, the app is not running after launch, or
 * the checks in devbox.json fail. `expo-devbox build` copies this file to the
 * worker, so it must not import anything but Bun and Node built-ins.
 *
 *   worker-build.ts             incremental build
 *   worker-build.ts --pods      run `pod install` first
 *   worker-build.ts --prebuild  install dependencies, run `expo prebuild` and `pod install` first
 */
import { $ } from 'bun';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

type Config = { waitFor?: string; failOn?: string; waitSeconds?: number; scheme?: string };

const state = join(homedir(), '.devbox');
const config: Config = existsSync('devbox.json') ? JSON.parse(readFileSync('devbox.json', 'utf8')) : {};
const waitSeconds = config.waitSeconds ?? (config.waitFor ? 60 : 8);
const prepareLog = join(state, 'prepare.log');

/** Runs a setup command with its output in prepare.log, which is printed only if the command fails. */
async function prepare(label: string, command: () => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>) {
  console.log(`Running: ${label}`);
  const result = await command();
  appendFileSync(prepareLog, `$ ${label}\n${result.stdout}${result.stderr}`);
  if (result.exitCode !== 0) {
    console.log(readFileSync(prepareLog, 'utf8').trimEnd().split('\n').slice(-30).join('\n'));
    console.log(`FAILED: ${label}. Full log: ${prepareLog}`);
    process.exit(1);
  }
}
const podInstall = () => prepare('pod install', () => $`pod install`.cwd('ios').quiet().nothrow());

writeFileSync(prepareLog, '');
const flag = process.argv[2];
if (flag === '--prebuild') {
  const manager = existsSync('bun.lock') || existsSync('bun.lockb') ? 'bun'
    : existsSync('pnpm-lock.yaml') ? 'pnpm' : existsSync('yarn.lock') ? 'yarn' : 'npm';
  await prepare(`${manager} install`, () => $`${manager} install`.quiet().nothrow());
  if (existsSync(join(state, 'cng'))) {
    await prepare('expo prebuild', () => $`npx expo prebuild --platform ios --no-install`.quiet().nothrow());
  }
  await podInstall();
} else if (flag === '--pods') {
  await podInstall();
} else if (flag) {
  console.log(`Unknown option ${flag}. Use --pods or --prebuild.`);
  process.exit(1);
}

const workspace = readdirSync('ios').find(name => name.endsWith('.xcworkspace'));
if (!workspace) {
  console.log('No .xcworkspace in ios/. Run the build again with --prebuild.');
  process.exit(1);
}
const scheme = config.scheme || basename(workspace, '.xcworkspace');
const udid = readFileSync(join(state, 'sim'), 'utf8').trim();
const derived = join(state, 'DerivedData');
const buildLog = join(state, 'xcodebuild.log');
const screenshot = join(state, 'screenshot.png');
rmSync(screenshot, { force: true });

const start = Date.now();
const seconds = () => Math.round((Date.now() - start) / 1000);
const build = await $`xcodebuild -workspace ${`ios/${workspace}`} -scheme ${scheme} -configuration Debug -sdk iphonesimulator \
  -destination ${`platform=iOS Simulator,id=${udid}`} -derivedDataPath ${derived} build &> ${buildLog}`.nothrow();
if (build.exitCode !== 0) {
  const lines = readFileSync(buildLog, 'utf8').split('\n');
  const errors = [...new Set(lines.filter(line => /(error|fatal error):/.test(line)))].slice(0, 40);
  console.log((errors.length ? errors : lines.slice(-30)).join('\n'));
  console.log(`BUILD FAILED after ${seconds()}s. Full log: ${buildLog}`);
  process.exit(1);
}
console.log(`BUILD SUCCEEDED in ${seconds()}s`);

const metroUp = await fetch('http://localhost:8081/status').then(r => r.ok, () => false);
if (!metroUp) {
  console.log('Metro is not running. The worker restarts it within a minute; run the build again then.');
  process.exit(1);
}

const products = join(derived, 'Build/Products/Debug-iphonesimulator');
const app = join(products, readdirSync(products).find(name => name.endsWith('.app'))!);
const plist = join(app, 'Info.plist');
const plistValue = async (key: string) => (await $`/usr/libexec/PlistBuddy -c ${`Print :${key}`} ${plist}`.text()).trim();
const bundleId = await plistValue('CFBundleIdentifier');
const executable = await plistValue('CFBundleExecutable');
const metroLog = join(state, 'metro.log');
const nativeLog = join(state, 'native.log');
const metroStart = readFileSync(metroLog).length;

await $`xcrun simctl install ${udid} ${app}`;
// Messages logged by code inside the app bundle, plus NSLog (sent from
// Foundation, with no subsystem); not the system libraries' own logging.
// `subsystem == ""` never matches, so "no subsystem" is written as no dot.
const predicate = `process == "${executable}" AND (senderImagePath CONTAINS "/${executable}.app/" `
  + `OR (senderImagePath ENDSWITH "/Foundation" AND NOT subsystem CONTAINS "."))`;
const logStream = Bun.spawn(['xcrun', 'simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--predicate', predicate],
  { stdout: Bun.file(nativeLog), stderr: 'ignore' });
await $`xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`.quiet();

const appOutput = () => readFileSync(metroLog).subarray(metroStart).toString()
  .split('\n').filter(line => /^ (LOG|WARN|ERROR) /.test(line)).join('\n');
// Simulator apps run as processes of the host.
const appRunning = async () => (await $`pgrep -f ${`/${executable}.app/${executable}`}`.quiet().nothrow()).exitCode === 0;
const matches = (pattern: string | undefined) => !!pattern && new RegExp(pattern, 'm').test(appOutput());

for (let i = 0; i < waitSeconds; i += 1) {
  if (matches(config.waitFor)) break;
  if (config.waitFor && i > 3 && !(await appRunning())) break;
  await Bun.sleep(1000);
}
if ((await $`xcrun simctl io ${udid} screenshot ${screenshot}`.quiet().nothrow()).exitCode !== 0) {
  console.log('Could not take a screenshot.');
}
logStream.kill();
await logStream.exited;

console.log('App console output from this launch:');
console.log(appOutput() || '(none)');
console.log('Native log from this launch (system libraries excluded):');
const native = readFileSync(nativeLog, 'utf8').split('\n')
  .filter(line => line && !/^(Filtering the log data|Timestamp |getpwuid_r |Child process terminated)/.test(line));
console.log(native.slice(-40).join('\n') || '(none)');

let status = 0;
if (!(await appRunning())) {
  console.log('The app is not running. It may have crashed at launch.');
  await printCrashReport(executable, statSync(plist).mtimeMs);
  status = 1;
}
if (config.waitFor && !matches(config.waitFor)) {
  console.log(`The app did not log a line matching waitFor (${config.waitFor}).`);
  status = 1;
}
if (matches(config.failOn)) {
  console.log(`The app logged a line matching failOn (${config.failOn}).`);
  status = 1;
}
process.exit(status);

/**
 * Prints the exception and the crashing thread's frames from the newest crash
 * report written since the build. macOS writes the report a few seconds after
 * the crash, so this waits for it.
 */
async function printCrashReport(executable: string, since: number) {
  const dir = join(homedir(), 'Library/Logs/DiagnosticReports');
  const newest = () => (existsSync(dir) ? readdirSync(dir) : [])
    .filter(name => name.startsWith(executable) && name.endsWith('.ips'))
    .map(name => ({ path: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
    .filter(report => report.time > since)
    .sort((a, b) => b.time - a.time)[0];
  let report = newest();
  for (let i = 0; !report && i < 10; i += 1) {
    await Bun.sleep(1000);
    report = newest();
  }
  if (!report) {
    console.log('No crash report appeared within 10 seconds.');
    return;
  }
  console.log(`Crash report ${report.path}:`);
  // An .ips file is a JSON header line followed by the JSON report.
  const text = readFileSync(report.path, 'utf8');
  try {
    const crash = JSON.parse(text.slice(text.indexOf('\n') + 1));
    console.log(`${crash.exception?.type} (${crash.exception?.signal}), ${crash.termination?.indicator ?? ''}`);
    const thread = crash.threads?.find((t: { triggered?: boolean }) => t.triggered);
    for (const frame of thread?.frames?.slice(0, 15) ?? []) {
      const where = frame.sourceFile ? ` (${frame.sourceFile}:${frame.sourceLine})` : '';
      console.log(`  ${crash.usedImages?.[frame.imageIndex]?.name ?? '?'}  ${frame.symbol ?? '?'}${where}`);
    }
  } catch {
    console.log(text.split('\n').slice(0, 40).join('\n'));
  }
}
