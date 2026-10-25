/**
 * The session commands: start a devbox workflow run, connect to its worker
 * over SSH through the Cloudflare tunnel it opens, sync files, run commands,
 * and stop it. Run from the app's root directory.
 *
 * A directory can have several sessions. Each one is a workflow run, and its
 * files are in .devbox/sessions/<run ID>/. Commands use the current session,
 * the one started or attached last, unless --session names another.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { matchSession, shortId } from './args';
import { status } from './status';

export const WORKFLOW = '.eas/workflows/ios-devbox.yml';
const STATE = '.devbox';
const SESSIONS = join(STATE, 'sessions');
const CURRENT = join(STATE, 'current');
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

type Run = { status: string; createdAt?: string; jobs?: { id: string }[] };
type Session = { id: string; dir: string; sshConfig: string };

const sessionAt = (id: string): Session => ({ id, dir: join(SESSIONS, id), sshConfig: join(SESSIONS, id, 'ssh_config') });

/** Session IDs in this directory, newest first. Workflow run IDs sort by start time. */
function sessionIds(): string[] {
  return existsSync(SESSIONS) ? readdirSync(SESSIONS).sort().reverse() : [];
}

let selected: string | undefined;
/** Sets the session that commands use, from --session or EXPO_DEVBOX_SESSION: an ID or a unique prefix of one. */
export function selectSession(prefix: string | undefined) {
  selected = prefix || undefined;
}

/** The session named with --session, else the current one, else the newest. */
function resolveSession(prefix = selected): Session {
  const ids = sessionIds();
  if (prefix) {
    try {
      return sessionAt(matchSession(ids, prefix));
    } catch (error) {
      fail((error as Error).message);
    }
  }
  if (ids.length === 0) fail('No devbox session in this directory. Start one with: expo-devbox start');
  const current = existsSync(CURRENT) ? readFileSync(CURRENT, 'utf8').trim() : '';
  return sessionAt(ids.includes(current) ? current : ids[0]!);
}

function forget(session: Session) {
  rmSync(session.dir, { recursive: true, force: true });
  if (existsSync(CURRENT) && readFileSync(CURRENT, 'utf8').trim() === session.id) rmSync(CURRENT);
}

async function viewRun(runId: string): Promise<Run | undefined> {
  const result = await $`eas workflow:view ${runId} --json --non-interactive`.quiet().nothrow();
  try {
    return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

/** Fails when the run has ended. A run that cannot be read (a network error) counts as running. */
async function requireActive(session: Session): Promise<Run | undefined> {
  const run = await viewRun(session.id);
  if (run && !ACTIVE.has(run.status)) {
    forget(session);
    fail(`The devbox session ${shortId(session.id)} ended with status ${run.status}. Start a new one with: expo-devbox start`);
  }
  if (run?.status === 'ACTION_REQUIRED') {
    status('blocked', { kind: 'permission', msg: 'The devbox workflow run needs approval on expo.dev' });
  }
  return run;
}

function requireProject() {
  if (!existsSync(WORKFLOW)) fail(`${WORKFLOW} is missing. Run expo-devbox init in the app's root directory first.`);
}

/**
 * Reads the tunnel host, user and host key from the job log and writes an SSH
 * config for them. The last DEVBOX_SSH_HOST wins, because the worker starts a
 * new tunnel, with a new host, if the old one exits. A host that does not
 * answer is skipped until a newer one appears in the log.
 */
async function connect(session: Session): Promise<void> {
  log(`Waiting for the worker to open its tunnel (session ${shortId(session.id)})...`);
  status('working', { msg: 'Waiting for the EAS worker' });
  let deadHost = '';
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const jobId = (await requireActive(session))?.jobs?.[0]?.id;
    if (jobId) {
      const logs = (await $`eas workflow:logs ${jobId} --non-interactive`.quiet().nothrow()).stdout.toString();
      const last = (pattern: RegExp) => [...logs.matchAll(pattern)].at(-1)?.[1];
      const host = last(/DEVBOX_SSH_HOST=([a-z0-9.-]+)/g);
      const user = last(/DEVBOX_SSH_USER=([A-Za-z0-9_-]+)/g);
      const hostKey = last(/DEVBOX_SSH_HOSTKEY=(ssh-ed25519 [A-Za-z0-9+/=]+)/g);
      if (host && user && hostKey && host !== deadHost) {
        writeSshConfig(session, host, user, hostKey);
        let error = '';
        // A new quick tunnel can take a few seconds to resolve in DNS.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const result = await $`ssh -F ${session.sshConfig} devbox true`.quiet().nothrow();
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

function writeSshConfig(session: Session, host: string, user: string, hostKey: string) {
  const knownHosts = join(session.dir, 'known_hosts');
  writeFileSync(knownHosts, `${host} ${hostKey}\n`);
  writeFileSync(session.sshConfig, `Host devbox
  HostName ${host}
  User ${user}
  ProxyCommand cloudflared access ssh --hostname %h
  IdentityFile ${KEY}
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ${resolve(knownHosts)}
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
async function ensureConnected(session: Session) {
  const probe = await $`ssh -F ${session.sshConfig} devbox true`.quiet().nothrow();
  if (probe.exitCode === SSH_FAILED) await connect(session);
}
const droppedMessage = 'The connection to the worker dropped while the command ran. It may have finished on the worker; check before you run it again.';

/** Waits for the worker to prepare the app: install, prebuild, pods, simulator, Metro and a first build. */
async function waitUntilReady(session: Session) {
  log('Waiting for the worker to prepare the app (about 3 minutes)...');
  status('working', { msg: 'The EAS worker is preparing the app' });
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const result = await $`ssh -F ${session.sshConfig} devbox ${'test -f ~/.devbox/ready'}`.quiet().nothrow();
    if (result.exitCode === 0) return;
    if (result.exitCode === SSH_FAILED) {
      await connect(session);
      continue;
    }
    await requireActive(session);
    await sleep(15);
  }
  fail('The worker is not ready after 20 minutes. See: expo-devbox joblog');
}

export async function start(args: string[]) {
  requireProject();
  if (!Bun.which('cloudflared')) fail('cloudflared is not installed. Install it with: brew install cloudflared');
  const [minutes = '60', idleMinutes = '15'] = args;
  if (!/^\d+$/.test(minutes) || !/^\d+$/.test(idleMinutes)) fail('Usage: expo-devbox start [minutes] [idle-minutes]');
  if (!existsSync(KEY)) await $`ssh-keygen -q -t ed25519 -N ${''} -C eas-devbox -f ${KEY}`;
  const publicKey = readFileSync(`${KEY}.pub`, 'utf8').trim();

  status('working', { msg: 'Starting an EAS macOS worker' });
  const result = await $`eas workflow:run ${WORKFLOW} --non-interactive --json -F ${`ssh_public_key=${publicKey}`} \
    -F ${`minutes=${minutes}`} -F ${`idle_minutes=${idleMinutes}`}`.env({ ...process.env, EAS_NO_VCS: '1' }).quiet().nothrow();
  if (result.exitCode !== 0) fail(`eas workflow:run failed:\n${result.stderr.toString().trim()}`);
  const session = sessionAt(JSON.parse(result.stdout.toString()).id);
  mkdirSync(session.dir, { recursive: true });
  writeFileSync(CURRENT, session.id);
  log(`Started session ${shortId(session.id)}: ${minutes} minutes at most, ending after ${idleMinutes} minutes without an SSH connection.`);

  // Cancel the run if this command fails or is interrupted, so it does not bill with nobody connected.
  const cancel = async () => {
    await $`eas workflow:cancel ${session.id} --non-interactive`.quiet().nothrow();
    forget(session);
  };
  const onInterrupt = async () => {
    log(`Cancelling session ${shortId(session.id)}.`);
    await cancel();
    status('idle');
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  try {
    await connect(session);
    await waitUntilReady(session);
  } catch (error) {
    log(`Cancelling session ${shortId(session.id)}.`);
    await cancel();
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  const others = sessionIds().filter(id => id !== session.id).length;
  console.log(`Session ${shortId(session.id)} is ready and is now the current session.${others ? ` This directory has ${others} other session${others === 1 ? '' : 's'}; see expo-devbox sessions.` : ''}`);
  console.log('Run expo-devbox help and follow "On the worker" to build and run the app.');
  status('done', { msg: 'The EAS worker is ready' });
}

export async function attach(args: string[]) {
  requireProject();
  const session = resolveSession(args[0] ?? selected);
  writeFileSync(CURRENT, session.id);
  await connect(session);
  await waitUntilReady(session);
  console.log(`Session ${shortId(session.id)} is ready and is now the current session.`);
  status('done', { msg: 'The EAS worker is ready' });
}

/** Lists this directory's sessions, newest first, and forgets the ones that have ended. */
export async function sessions() {
  requireProject();
  const ids = sessionIds();
  if (ids.length === 0) {
    console.log('No devbox sessions in this directory. Start one with: expo-devbox start');
    return;
  }
  const current = resolveSession('').id;
  for (const id of ids) {
    const run = await viewRun(id);
    const started = run?.createdAt ? new Date(run.createdAt).toLocaleString() : '';
    const state = run?.status ?? 'UNKNOWN';
    console.log(`${id === current ? '*' : ' '} ${shortId(id)}  ${state.padEnd(15)} ${started}`);
    if (run && !ACTIVE.has(run.status)) forget(sessionAt(id));
  }
  console.log('\n* the current session. Pick another with --session <id> or EXPO_DEVBOX_SESSION=<id>; any unique prefix works.');
}

/**
 * Sends what git would track. .gitignore patterns also protect worker-only
 * files (such as a generated ios/) from --delete. rsync cannot express
 * gitignore's `!` re-includes, so those lines are dropped.
 */
export async function sync() {
  requireProject();
  const session = resolveSession();
  const gitignore = existsSync('.gitignore')
    ? readFileSync('.gitignore', 'utf8').split('\n').filter(line => !/^\s*!/.test(line))
    : [];
  const ignored = (await $`git ls-files -oi --exclude-standard --directory`.quiet().nothrow()).stdout.toString()
    .split('\n').filter(Boolean).map(path => `/${path}`);
  const excludes = join(session.dir, 'rsync-excludes');
  writeFileSync(excludes, [...gitignore, ...ignored].join('\n') + '\n');
  await ensureConnected(session);
  const { exitCode } = await $`rsync -az --delete -e ${`ssh -F ${session.sshConfig}`} \
    --exclude .git --exclude node_modules --exclude /.devbox --exclude /ios/Pods --exclude-from=${excludes} \
    ./ devbox:project/`.nothrow();
  if (exitCode !== 0) fail(`rsync exited ${exitCode}. Run expo-devbox sync again; it only sends what changed.`);
}

export async function shell(args: string[]) {
  requireProject();
  const session = resolveSession();
  if (args.length === 0) {
    const child = Bun.spawn(['ssh', '-F', session.sshConfig, '-t', 'devbox', 'cd ~/project && exec $SHELL'],
      { stdio: ['inherit', 'inherit', 'inherit'] });
    process.exitCode = await child.exited;
    return;
  }
  await ensureConnected(session);
  const { exitCode } = await $`ssh -F ${session.sshConfig} devbox ${`cd ~/project && ${args.join(' ')}`}`.nothrow();
  if (exitCode === SSH_FAILED) console.error(droppedMessage);
  process.exitCode = exitCode;
}

/** Copies a file from the worker. A relative path is relative to the app's directory there. */
export async function pull(args: string[]) {
  requireProject();
  const [path, destination = '.'] = args;
  if (!path) throw new UserError('Usage: expo-devbox pull <path on the worker> [local directory or file]');
  const session = resolveSession();
  await ensureConnected(session);
  const remote = path.startsWith('/') || path.startsWith('~') ? path : `project/${path}`;
  const { exitCode } = await $`scp -q -F ${session.sshConfig} ${`devbox:${remote}`} ${destination}`.nothrow();
  if (exitCode !== 0) fail(`Could not copy ${path} from the worker (scp exited ${exitCode}).`);
}

export async function joblog() {
  requireProject();
  const session = resolveSession();
  const jobId = (await viewRun(session.id))?.jobs?.[0]?.id;
  if (!jobId) fail(`Could not find the job of session ${shortId(session.id)}. See: eas workflow:view ${session.id}`);
  await $`eas workflow:logs ${jobId} --non-interactive`.nothrow();
}

async function stopOne(session: Session): Promise<string> {
  await $`eas workflow:cancel ${session.id} --non-interactive`.quiet().nothrow();
  // eas workflow:cancel exits 0 even when it fails, so wait for the run's final status instead.
  const result = await $`eas workflow:status ${session.id} --wait --non-interactive`.quiet().nothrow();
  await $`ssh -F ${session.sshConfig} -O exit devbox`.quiet().nothrow();
  const ended: Record<number, string> = { 0: 'had already finished', 11: 'had already failed', 12: 'is canceled' };
  if (!(result.exitCode in ended)) {
    fail(`Could not confirm that session ${shortId(session.id)} ended (eas workflow:status exited ${result.exitCode}). Check: eas workflow:view ${session.id}`);
  }
  forget(session);
  return `The devbox session ${shortId(session.id)} ${ended[result.exitCode]}.`;
}

export async function stop(args: string[]) {
  requireProject();
  const all = args.includes('--all');
  const targets = all ? sessionIds().map(sessionAt) : [resolveSession()];
  if (targets.length === 0) {
    console.log('No devbox sessions in this directory.');
    return;
  }
  status('working', { msg: all ? 'Ending all devbox sessions' : 'Ending the devbox session' });
  // With --all, one session that cannot be confirmed does not stop the others from ending.
  const failures: string[] = [];
  for (const session of targets) {
    try {
      console.log(await stopOne(session));
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      failures.push(error.message);
    }
  }
  if (failures.length) fail(failures.join('\n'));
  status('done', { msg: all ? 'All devbox sessions ended' : 'Devbox session ended' });
}
