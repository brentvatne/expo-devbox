import { describe, expect, test } from 'bun:test';

import { matchSession, parseArgs, shortId } from '../src/args';

describe('parseArgs', () => {
  test('reads --session before or after the command', () => {
    expect(parseArgs(['--session', '01a1', 'ssh', 'ls'])).toEqual({ command: 'ssh', args: ['ls'], session: '01a1' });
    expect(parseArgs(['ssh', '-s', '01a1', 'ls'])).toEqual({ command: 'ssh', args: ['ls'], session: '01a1' });
    expect(parseArgs(['stop', '--session=01a1', '--all'])).toEqual({ command: 'stop', args: ['--all'], session: '01a1' });
  });

  test('leaves the remote command of ssh alone', () => {
    expect(parseArgs(['ssh', 'grep --session x', '-s'])).toEqual({ command: 'ssh', args: ['grep --session x', '-s'] });
  });
});

describe('matchSession', () => {
  const ids = ['01a170bb-d83c-7773-a6f7-fbee07eedaf5', '01a170bb-e001-7000-8000-000000000000', '01a170c2-0000-7000-8000-000000000000'];

  test('accepts a unique prefix', () => {
    expect(matchSession(ids, '01a170c')).toBe(ids[2]!);
    expect(matchSession(ids, '01a170bb-d8')).toBe(ids[0]!);
  });

  test('explains an ambiguous or unknown prefix', () => {
    expect(() => matchSession(ids, '01a170bb')).toThrow('matches 2 sessions');
    expect(() => matchSession(ids, 'ff')).toThrow('No devbox session');
  });

  test('shows IDs to the millisecond of their start', () => {
    expect(shortId(ids[0]!)).toBe('01a170bb-d83c');
  });
});
