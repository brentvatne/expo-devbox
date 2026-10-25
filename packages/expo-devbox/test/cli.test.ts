import { describe, expect, test } from 'bun:test';

import { INTRO_NAMES, intros, pickIntro, PLAIN, WORDMARK } from '../src/intro';
import { formatStatus } from '../src/status';

describe('formatStatus', () => {
  test('writes an OSC 7501 report with a base64 message', () => {
    expect(formatStatus('working', { msg: 'Building', progress: 40.4 }))
      .toBe(`\x1b]7501;state=working:app=expo-devbox:progress=40:msg=${btoa('Building')}\x1b\\`);
  });

  test('sends kind only with blocked, and strips control characters from the message', () => {
    expect(formatStatus('working', { kind: 'permission' })).not.toContain('kind=');
    const report = formatStatus('blocked', { kind: 'permission', msg: 'Approve\nthe run' });
    expect(report).toContain('kind=permission');
    expect(report).toContain(`msg=${btoa('Approve the run')}`);
  });
});

describe('intros', () => {
  test.each(INTRO_NAMES)('%s ends on the wordmark', name => {
    expect(intros(42)[name].frame(1, PLAIN).map(row => row.trimEnd())).toEqual(WORDMARK.map(row => row.trimEnd()));
  });

  test('EXPO_DEVBOX_INTRO picks one or turns them off', () => {
    expect(pickIntro({ EXPO_DEVBOX_INTRO: 'beams' })).toBe('beams');
    expect(pickIntro({ EXPO_DEVBOX_INTRO: 'off' })).toBeUndefined();
    expect(pickIntro({}, () => 0)).toBe('slider');
  });
});
