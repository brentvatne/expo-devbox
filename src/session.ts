/**
 * The session commands: start a devbox workflow run, connect to its worker
 * over SSH through the Cloudflare tunnel it opens, sync files, run commands,
 * and stop it. Run from the app's root directory.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { status } from './status';

export const WORKFLOW = '.eas/workflows/ios-devbox.yml';
const STATE = '.devbox';
const SSH_CONFIG = join(STATE, 'ssh_config');
const RUN_ID = join(STATE, 'run_id');
const KEY = join(homedir(), '.ssh', 'eas_devbox');
const ACTIVE = new Set(['NEW', 'WAITING', 'IN_PROGRESS', 'ACTION_REQUIRED']);
/** ssh's exit code when it could not connect, as opposed to the remote command's own code. */
const SSH_FAILED = 255;

/** An error whose message is meant for the person or agent running the command. */
export class UserError extends Error {}
const fail = (message: string): never => {
  throw new UserError(message);
};
const log = (message: string) => console.error(message);
const sleep = (seconds: number) => Bun.sleep(seconds * 1000);

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
    fail(`The devbox session ended with status ${run.status}. Start a new one with: expo-devbox start`);
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
  if (!existsSync(WORKFLOW)) fail(`${WORKFLOW} is missing. Run expo-devbox init in the app's root directory first.`);
  mkdirSync(STATE, { recursive: true });
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
  fail('Could not reach the worker for 15 minutes. See: expo-devbox joblog');
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

/**
 * Reconnects first if the worker is unreachable, for example because its
 * tunnel moved. A command is never run twice: if the connection drops while
 * it runs, it may already have done its work.
 */
async function ensureConnected() {
  const probe = await $`ssh -F ${SSH_CONFIG} devbox true`.quiet().nothrow();
  if (probe.exitCode === SSH_FAILED) await connect(savedRun());
}
const droppedMessage = 'The connection to the worker dropped while the command ran. It may have finished on the worker; check before you run it again.';

/** Waits for the worker to prepare the app: install, prebuild, pods, simulator, Metro and a first build. */
async function waitUntilReady(runId: string) {
  log('Waiting for the worker to prepare the app (about 3 minutes)...');
  status('working', { msg: 'The EAS worker is preparing the app' });
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const result = await $`ssh -F ${SSH_CONFIG} devbox ${'test -f ~/.devbox/ready'}`.quiet().nothrow();
    if (result.exitCode === 0) return;
    if (result.exitCode === SSH_FAILED) {
      await connect(runId);
      continue;
    }
    await requireActive(runId);
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
      fail(`A devbox session is already running (run ${previous}). Use it, or end it with: expo-devbox stop`);
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
  log(`Started run ${runId}: ${minutes} minutes at most, ending after ${idleMinutes} minutes without an SSH connection.`);

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
    await waitUntilReady(runId);
  } catch (error) {
    log(`Cancelling run ${runId}.`);
    await cancel();
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  console.log('The worker is ready. Run expo-devbox help and follow "On the worker" to build and run the app.');
  status('done', { msg: 'The EAS worker is ready' });
}

export async function attach(args: string[]) {
  requireProject();
  const runId = args[0] ?? savedRun();
  writeFileSync(RUN_ID, runId);
  await connect(runId);
  await waitUntilReady(runId);
  console.log('The worker is ready.');
  status('done', { msg: 'The EAS worker is ready' });
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
  await ensureConnected();
  const { exitCode } = await $`rsync -az --delete -e ${`ssh -F ${SSH_CONFIG}`} \
    --exclude .git --exclude node_modules --exclude /.devbox --exclude /ios/Pods --exclude-from=${excludes} \
    ./ devbox:project/`.nothrow();
  if (exitCode !== 0) fail(`rsync exited ${exitCode}. Run expo-devbox sync again; it only sends what changed.`);
}

export async function shell(args: string[]) {
  requireProject();
  if (args.length === 0) {
    const child = Bun.spawn(['ssh', '-F', SSH_CONFIG, '-t', 'devbox', 'cd ~/project && exec $SHELL'],
      { stdio: ['inherit', 'inherit', 'inherit'] });
    process.exitCode = await child.exited;
    return;
  }
  await ensureConnected();
  const { exitCode } = await $`ssh -F ${SSH_CONFIG} devbox ${`cd ~/project && ${args.join(' ')}`}`.nothrow();
  if (exitCode === SSH_FAILED) console.error(droppedMessage);
  process.exitCode = exitCode;
}

export async function joblog() {
  requireProject();
  const jobId = (await viewRun(savedRun()))?.jobs?.[0]?.id;
  if (!jobId) fail(`Could not find the job of the devbox run. See: eas workflow:view ${savedRun()}`);
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
