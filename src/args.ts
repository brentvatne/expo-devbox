/** Command-line parsing, kept apart from the commands so it can be tested. */
export type Parsed = { command?: string; args: string[]; session?: string };

/**
 * Splits argv into the command, its arguments and a --session value.
 * `--session <id>`, `--session=<id>` and `-s <id>` are read before the command
 * and before the command's first argument, so a remote command passed to `ssh`
 * is never parsed: `expo-devbox ssh -s 01a1 'ls --session'`.
 */
export function parseArgs(argv: string[]): Parsed {
  let session: string | undefined;
  let command: string | undefined;
  const args: string[] = [];
  let i = 0;
  const readFlags = () => {
    while (i < argv.length) {
      const arg = argv[i]!;
      if (arg === '--session' || arg === '-s') {
        session = argv[i + 1];
        i += 2;
      } else if (arg.startsWith('--session=')) {
        session = arg.slice('--session='.length);
        i += 1;
      } else {
        return;
      }
    }
  };
  readFlags();
  if (i < argv.length) command = argv[i++];
  readFlags();
  args.push(...argv.slice(i));
  return { command, args, ...(session ? { session } : {}) };
}

/** Finds the one session ID that starts with the prefix. */
export function matchSession(ids: string[], prefix: string): string {
  const matches = ids.filter(id => id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(`No devbox session in this directory starts with "${prefix}". See: expo-devbox sessions`);
  }
  throw new Error(`"${prefix}" matches ${matches.length} sessions: ${matches.map(shortId).join(', ')}. Use more of the ID.`);
}

/** The part of a session (workflow run) ID that is shown: unique per millisecond of start time. */
export function shortId(id: string): string {
  return id.slice(0, 13);
}
