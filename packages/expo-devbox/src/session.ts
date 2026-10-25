/**
 * The session commands: start a devbox workflow run, connect to its worker
 * over SSH through the Cloudflare tunnel it opens, sync sources, build, and
 * stop it. Run from the project root.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { status } from './status';

export const WORKFLOW = '.eas/workflows/ios-devbox.yml';
const STATE = '.devbox';
const SSH_CONFIG = join(STATE, 'ssh_config');
const RUN_ID = join(STATE, 'run_id');
const KEY = join(homedir(), '.ssh', 'eas_devbox');
const WORKER_SCRIPT = join(import.meta.dir, 'worker-build.ts');
const ACTIVE = new Set(['NEW', 'WAITING', 'IN_PROGRESS', 'ACTION_REQUIRED']);

/** An error whose message is meant for the person or agent running the command. */
export class UserError extends Error {}
const fail = (message: string): never => {
  throw new UserError(message);
};
const log = (message: string) => console.error(message);
const sleep = (seconds: number) => Bun.sleep(seconds * 1000);
/** Quotes a value for the worker's shell. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type Run = { status: string; jobs?: { id: string }[] };

async function viewRun(runId: string): Promise<Run | undefined> {
  const result = await $`eas workflow:view ${runId} --json --non-interactive`.quiet().nothrow();
  try {
    return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

/** Fails when the run has ended. A run that cannot be read (a network error) counts as running. */
async function requireActive(runId: string): Promise<Run | undefined> {
  const run = await viewRun(runId);
  if (run && !ACTIVE.has(run.status)) {
    fail(`The devbox session ended with status ${run.status}. See: eas workflow:view ${runId}`);
  }
  if (run?.status === 'ACTION_REQUIRED') {
    status('blocked', { kind: 'permission', msg: 'The devbox workflow run needs approval on expo.dev' });
  }
  return run;
}

function savedRun(): string {
  if (!existsSync(RUN_ID)) fail('No devbox session. Start one with: expo-devbox start');
  return readFileSync(RUN_ID, 'utf8').trim();
}

function requireProject() {
  if (!existsSync(WORKFLOW)) fail(`${WORKFLOW} is missing. Run expo-devbox init in the project root first.`);
  mkdirSync(STATE, { recursive: true });
}

function ssh(remoteCommand: string) {
  return $`ssh -F ${SSH_CONFIG} devbox ${remoteCommand}`;
}

/**
 * Reads the tunnel host, user and host key from the job log and writes an SSH
 * config for them. The last DEVBOX_SSH_HOST wins, because the worker starts a
 * new tunnel, with a new host, if the old one exits. A host that does not
 * answer is skipped until a newer one appears in the log.
 */
async function connect(runId: string): Promise<void> {
  log(`Waiting for the worker to open its tunnel (run ${runId})...`);
  status('working', { msg: 'Waiting for the EAS worker' });
  let deadHost = '';
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const jobId = (await requireActive(runId))?.jobs?.[0]?.id;
    if (jobId) {
      const logs = (await $`eas workflow:logs ${jobId} --non-interactive`.quiet().nothrow()).stdout.toString();
      const last = (pattern: RegExp) => [...logs.matchAll(pattern)].at(-1)?.[1];
      const host = last(/DEVBOX_SSH_HOST=([a-z0-9.-]+)/g);
      const user = last(/DEVBOX_SSH_USER=([A-Za-z0-9_-]+)/g);
      const hostKey = last(/DEVBOX_SSH_HOSTKEY=(ssh-ed25519 [A-Za-z0-9+/=]+)/g);
      if (host && user && hostKey && host !== deadHost) {
        writeSshConfig(host, user, hostKey);
        let error = '';
        // A new quick tunnel can take a few seconds to resolve in DNS.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const result = await $`ssh -F ${SSH_CONFIG} devbox true`.quiet().nothrow();
          if (result.exitCode === 0) {
            log(`Connected to ${user}@${host}.`);
            return;
          }
          error = result.stderr.toString().trim().split('\n').at(-1) ?? '';
          await sleep(5);
        }
        log(`${host} does not answer (${error}). Waiting for the worker to open a new tunnel...`);
        deadHost = host;
      }
    }
    await sleep(10);
  }
  fail(`Could not reach the worker for 15 minutes. See: eas workflow:view ${runId}`);
}

function writeSshConfig(host: string, user: string, hostKey: string) {
  writeFileSync(join(STATE, 'known_hosts'), `${host} ${hostKey}\n`);
  writeFileSync(SSH_CONFIG, `Host devbox
  HostName ${host}
  User ${user}
  ProxyCommand cloudflared access ssh --hostname %h
  IdentityFile ${KEY}
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ${resolve(STATE, 'known_hosts')}
  ConnectTimeout 20
  ServerAliveInterval 30
  ControlMaster auto
  ControlPath ~/.ssh/cm-devbox-%C
  ControlPersist 5m
`);
}

/** Waits for the worker to finish preparing the project. Reconnects if the worker is unreachable. */
async function waitUntilReady(runId: string) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const result = await ssh('test -f ~/.devbox/ready').quiet().nothrow();
    if (result.exitCode === 0) return;
    if (result.exitCode === 255) {
      await connect(runId);
      continue;
    }
    await requireActive(runId);
    log('Waiting for the worker to finish preparing the project...');
    status('working', { msg: 'The EAS worker is preparing the project' });
    await sleep(15);
  }
  fail('The worker is not ready after 20 minutes. See: expo-devbox joblog');
}

export async function start(args: string[]) {
  requireProject();
  if (!Bun.which('cloudflared')) fail('cloudflared is not installed. Install it with: brew install cloudflared');
  if (existsSync(RUN_ID)) {
    const previous = readFileSync(RUN_ID, 'utf8').trim();
    const run = await viewRun(previous);
    if (run && ACTIVE.has(run.status)) {
      fail(`A devbox session is already running (run ${previous}). Use expo-devbox attach or expo-devbox stop.`);
    }
  }
  const [minutes = '60', idleMinutes = '15'] = args;
  if (!/^\d+$/.test(minutes) || !/^\d+$/.test(idleMinutes)) fail('Usage: expo-devbox start [minutes] [idle-minutes]');
  if (!existsSync(KEY)) await $`ssh-keygen -q -t ed25519 -N ${''} -C eas-devbox -f ${KEY}`;
  const publicKey = readFileSync(`${KEY}.pub`, 'utf8').trim();

  status('working', { msg: 'Starting an EAS macOS worker' });
  const result = await $`eas workflow:run ${WORKFLOW} --non-interactive --json -F ${`ssh_public_key=${publicKey}`} \
    -F ${`minutes=${minutes}`} -F ${`idle_minutes=${idleMinutes}`}`.env({ ...process.env, EAS_NO_VCS: '1' }).quiet().nothrow();
  if (result.exitCode !== 0) fail(`eas workflow:run failed:\n${result.stderr.toString().trim()}`);
  const runId: string = JSON.parse(result.stdout.toString()).id;
  writeFileSync(RUN_ID, runId);
  log(`Started run ${runId}: ${minutes} minutes at most, ending after ${idleMinutes} idle minutes.`);

  // Cancel the run if this command fails or is interrupted, so it does not bill with nobody connected.
  const cancel = () => $`eas workflow:cancel ${runId} --non-interactive`.quiet().nothrow();
  const onInterrupt = async () => {
    log(`Cancelling run ${runId}.`);
    await cancel();
    status('idle');
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  try {
    await connect(runId);
  } catch (error) {
    log(`Cancelling run ${runId}.`);
    await cancel();
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  log(`The worker is still preparing the project. 'expo-devbox build' waits for it.`);
  status('done', { msg: 'Connected to the EAS worker' });
}

export async function attach(args: string[]) {
  requireProject();
  const runId = args[0] ?? savedRun();
  writeFileSync(RUN_ID, runId);
  await connect(runId);
  status('done', { msg: 'Connected to the EAS worker' });
}

/**
 * Sends what git would track. .gitignore patterns also protect worker-only
 * files (such as a generated ios/) from --delete. rsync cannot express
 * gitignore's `!` re-includes, so those lines are dropped.
 */
export async function sync() {
  requireProject();
  const gitignore = existsSync('.gitignore')
    ? readFileSync('.gitignore', 'utf8').split('\n').filter(line => !/^\s*!/.test(line))
    : [];
  const ignored = (await $`git ls-files -oi --exclude-standard --directory`.quiet().nothrow()).stdout.toString()
    .split('\n').filter(Boolean).map(path => `/${path}`);
  const excludes = join(STATE, 'rsync-excludes');
  writeFileSync(excludes, [...gitignore, ...ignored].join('\n') + '\n');
  await $`rsync -az --delete -e ${`ssh -F ${SSH_CONFIG}`} --exclude .git --exclude node_modules --exclude /.devbox \
    --exclude /ios/Pods --exclude-from=${excludes} ./ devbox:project/`;
}

export async function build(args: string[]) {
  requireProject();
  const [option] = args;
  if (option && option !== '--pods' && option !== '--prebuild') fail('Usage: expo-devbox build [--pods|--prebuild]');
  const runId = savedRun();
  status('working', { msg: 'Waiting for the EAS worker' });
  await waitUntilReady(runId);
  status('working', { msg: 'Syncing sources to the EAS worker' });
  await sync();
  await $`scp -q -F ${SSH_CONFIG} ${WORKER_SCRIPT} devbox:.devbox/worker-build.ts`;

  status('working', { msg: option ? `Building on the EAS worker (${option.slice(2)})` : 'Building on the EAS worker' });
  const screenshot = join(STATE, 'screenshot.png');
  rmSync(screenshot, { force: true });
  const result = await ssh(`cd ~/project && bun ~/.devbox/worker-build.ts ${option ?? ''}`).nothrow();
  if ((await $`scp -q -F ${SSH_CONFIG} devbox:.devbox/screenshot.png ${screenshot}`.quiet().nothrow()).exitCode === 0) {
    console.log(`Screenshot copied to ${screenshot}`);
  }
  const summary = result.stdout.toString().match(/BUILD (SUCCEEDED|FAILED)[^\n]*/)?.[0];
  if (result.exitCode === 0) {
    status('done', { msg: summary ?? 'Build succeeded' });
  } else {
    status('error', { msg: summary?.startsWith('BUILD FAILED') ? summary : 'The app failed its checks; see the output' });
  }
  process.exitCode = result.exitCode;
}

export async function logs(args: string[]) {
  requireProject();
  await ssh(`grep -a -E ${quote(args[0] ?? '.')} ~/.devbox/metro.log | tail -50`).nothrow();
}

export async function shell(args: string[]) {
  requireProject();
  if (args.length === 0) {
    const child = Bun.spawn(['ssh', '-F', SSH_CONFIG, '-t', 'devbox', 'cd ~/project && exec $SHELL'],
      { stdio: ['inherit', 'inherit', 'inherit'] });
    process.exitCode = await child.exited;
    return;
  }
  process.exitCode = (await ssh(`cd ~/project && ${args.join(' ')}`).nothrow()).exitCode;
}

export async function joblog() {
  requireProject();
  const jobId = (await viewRun(savedRun()))?.jobs?.[0]?.id;
  if (!jobId) fail('Could not find the job of the devbox run. See: eas workflow:view ' + savedRun());
  await $`eas workflow:logs ${jobId} --non-interactive`.nothrow();
}

export async function stop() {
  requireProject();
  const runId = savedRun();
  status('working', { msg: 'Ending the devbox session' });
  await $`eas workflow:cancel ${runId} --non-interactive`.quiet().nothrow();
  // eas workflow:cancel exits 0 even when it fails, so wait for the run's final status instead.
  const result = await $`eas workflow:status ${runId} --wait --non-interactive`.quiet().nothrow();
  await $`ssh -F ${SSH_CONFIG} -O exit devbox`.quiet().nothrow();
  const ended: Record<number, string> = { 0: 'had already finished', 11: 'had already failed', 12: 'is canceled' };
  if (!(result.exitCode in ended)) {
    fail(`Could not confirm that run ${runId} ended (eas workflow:status exited ${result.exitCode}). Check: eas workflow:view ${runId}`);
  }
  console.log(`The devbox session ${ended[result.exitCode]}.`);
  status('done', { msg: 'Devbox session ended' });
}
