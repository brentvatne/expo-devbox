/**
 * Reports what the CLI is doing to the terminal with the Program Status
 * Protocol (OSC 7501): https://www.superlogical.com/rex/docs/build/program-status
 * Terminals that do not implement it ignore the sequence. Reports go to stderr,
 * and only when stderr is a terminal, so captured output (an agent, CI, a pipe)
 * never contains them.
 */
export type State = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
export type Report = { msg?: string; progress?: number; kind?: 'permission' | 'question' | 'auth' };

const MAX_MSG_BYTES = 2048;

/** Builds the escape sequence for a report. */
export function formatStatus(state: State, report: Report = {}): string {
  const pairs = [`state=${state}`, 'app=expo-devbox'];
  if (report.kind && state === 'blocked') pairs.push(`kind=${report.kind}`);
  if (report.progress !== undefined) pairs.push(`progress=${Math.max(0, Math.min(100, Math.round(report.progress)))}`);
  if (report.msg) {
    // One line of text, without control characters, within the spec's size limit.
    let bytes = Buffer.from(report.msg.replace(/[\x00-\x1f\x7f]+/g, ' ').trim());
    if (bytes.length > MAX_MSG_BYTES) bytes = bytes.subarray(0, MAX_MSG_BYTES);
    pairs.push(`msg=${bytes.toString('base64')}`);
  }
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

export function status(state: State, report: Report = {}): void {
  if (process.stderr.isTTY) process.stderr.write(formatStatus(state, report));
}
