/**
 * The "expo devbox" wordmark the CLI opens with when a person runs it in a
 * terminal, and the five ways it can arrive. One is picked at random each
 * launch (EXPO_DEVBOX_INTRO names one, or `off`). Each intro is a function of
 * progress t (0..1) to the wordmark's two rows, so it can be drawn at any
 * frame rate and tested without a terminal. Adapted from Expo Explore.
 */
export type Paint = Record<'white' | 'text' | 'dim' | 'faint' | 'amber' | 'green' | 'yellow' | 'blue' | 'red', (text: string) => string>;
export type Intro = { duration: number; frame: (t: number, paint: Paint) => string[] };

const sgr = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const COLOR: Paint = {
  white: sgr('1;97'), text: sgr('97'), dim: sgr('38;5;244'), faint: sgr('38;5;238'), amber: sgr('38;5;214'),
  green: sgr('38;5;114'), yellow: sgr('38;5;221'), blue: sgr('38;5;111'), red: sgr('38;5;203'),
};
export const PLAIN: Paint = {
  white: s => s, text: s => s, dim: s => s, faint: s => s, amber: s => s, green: s => s, yellow: s => s, blue: s => s, red: s => s,
};

// A two-row pixel font: one column between letters, three between words.
const GLYPHS: Record<string, [string, string]> = {
  b: ['█▄▄', '█▄█'], d: ['█▀▄', '█▄▀'], e: ['█▀▀', '██▄'], o: ['█▀█', '█▄█'],
  p: ['█▀█', '█▀▀'], v: ['█ █', '▀▄▀'], x: ['▀▄▀', '█ █'],
};
export const WORDMARK: string[] = [0, 1].map(row =>
  'expo devbox'.split(' ').map(word => [...word].map(letter => GLYPHS[letter]![row]).join(' ')).join('   '));
const WIDTH = WORDMARK[0]!.length;
const NOISE = [...'░▒▓▚▞▖▗▘▝◆◇○●■□▪▫'];

const ease = (t: number) => 1 - (1 - t) ** 3;
/** A small seeded random, so an intro plays the same way for the same seed (and in tests). */
function seeded(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}
const cells = (fn: (ch: string, row: number, column: number) => string) =>
  WORDMARK.map((row, r) => [...row].map((ch, c) => fn(ch, r, c)).join(''));

export function intros(seed = 7): Record<IntroName, Intro> {
  const random = seeded(seed);
  // decrypt: when each letter locks in.
  const lock = WORDMARK.map(row => [...row].map(() => 0.3 + random() * 0.6));
  // snap: letters start in each other's places and each snaps home at its own moment.
  const swaps = WORDMARK.map(row => {
    const map = [...row].map((_, c) => c);
    const letters = map.filter(c => row[c] !== ' ');
    for (let i = 0; i < letters.length * 0.35; i += 1) {
      const a = letters[Math.floor(random() * letters.length)]!;
      const b = letters[Math.floor(random() * letters.length)]!;
      [map[a], map[b]] = [map[b]!, map[a]!];
    }
    return map.map((from, c) => ({ from, at: from === c ? 0 : 0.3 + random() * 0.5 }));
  });
  const noise = () => NOISE[Math.floor(random() * NOISE.length)]!;
  return {
    // A compare slider: the crisp wordmark behind the handle, a faded one ahead of it.
    slider: { duration: 600, frame: (t, paint) => {
      const at = Math.round(ease(t) * WIDTH);
      return cells((ch, _r, c) => c === at && t < 1 ? paint.amber('┃') : c < at ? paint.white(ch) : paint.faint(ch === ' ' ? ' ' : '░'));
    } },
    // Every letter cycles through noise, then locks in with an amber flash.
    decrypt: { duration: 900, frame: (t, paint) => cells((ch, r, c) => {
      if (ch === ' ') return ' ';
      const at = lock[r]![c]!;
      if (t < at) return (t < 0.15 ? paint.faint : paint.blue)(noise());
      return t < at + 0.07 ? paint.amber(ch) : paint.white(ch);
    }) },
    // A diagonal beam of light draws the wordmark as it passes.
    beams: { duration: 700, frame: (t, paint) => {
      const beam = t * (WIDTH + 16) - 6;
      return cells((ch, r, c) => {
        const distance = c + r * 3 - beam;
        return distance > 0 ? ' ' : distance > -3 ? paint.amber(ch === ' ' ? '·' : ch) : distance > -6 ? paint.yellow(ch) : paint.white(ch);
      });
    } },
    // A build fixing itself: misplaced letters (amber) snap home (green), then settle.
    snap: { duration: 900, frame: (t, paint) => cells((ch, r, c) => {
      const { from, at } = swaps[r]![c]!;
      const original = WORDMARK[r]![from]!;
      if (t < 0.12) return paint.faint(original === ' ' ? ' ' : '░');
      if (at === 0) return paint.text(ch);
      if (t < at) return paint.amber(original);
      return t < at + 0.1 ? paint.green(ch) : paint.white(ch);
    }) },
    // Letters glide in from the right one after another, gray to white.
    slide: { duration: 800, frame: (t, paint) => WORDMARK.map(row => {
      const out = Array.from({ length: WIDTH + 24 }, () => ' ');
      for (let c = 0; c < WIDTH; c += 1) {
        if (row[c] === ' ') continue;
        const local = Math.min(1, Math.max(0, (t - (c / WIDTH) * 0.5) / 0.5));
        if (local === 0) continue;
        out[c + Math.round((1 - ease(local)) * 24)] = (local < 1 ? paint.dim : paint.white)(row[c]!);
      }
      return out.join('').trimEnd();
    }) },
  };
}

export const INTRO_NAMES = ['slider', 'decrypt', 'beams', 'snap', 'slide'] as const;
export type IntroName = (typeof INTRO_NAMES)[number];

/** EXPO_DEVBOX_INTRO when it names one (or `off`), otherwise a random one. */
export function pickIntro(environment: NodeJS.ProcessEnv, random = Math.random): IntroName | undefined {
  const chosen = environment.EXPO_DEVBOX_INTRO?.trim().toLowerCase();
  if (chosen === 'off' || chosen === 'none') return undefined;
  if (chosen && (INTRO_NAMES as readonly string[]).includes(chosen)) return chosen as IntroName;
  return INTRO_NAMES[Math.floor(random() * INTRO_NAMES.length)];
}

/**
 * Plays an intro in place and leaves the finished wordmark on screen. Only for
 * a person at a color terminal: agents and CI get plain output.
 */
export async function playIntro(output: NodeJS.WriteStream = process.stdout): Promise<void> {
  const color = output.isTTY && !process.env.NO_COLOR && !process.env.CI;
  const paint = color ? COLOR : PLAIN;
  // A width of 0 means the terminal did not report one.
  const name = color && (output.columns || 80) >= WIDTH + 6 ? pickIntro(process.env) : undefined;
  const indent = (rows: string[]) => rows.map(row => `   ${row}`);
  if (!name) {
    output.write(`\n${indent(WORDMARK.map(row => paint.white(row))).join('\n')}\n\n`);
    return;
  }
  const intro = intros(Date.now())[name];
  const restore = () => output.write('\x1b[?25h');
  process.once('exit', restore);
  output.write(`\x1b[?25l\n${'\n'.repeat(WORDMARK.length)}`);
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / intro.duration);
    output.write(`\x1b[${WORDMARK.length}A${indent(intro.frame(t, paint)).map(row => `\r${row}\x1b[K`).join('\n')}\n`);
    if (t === 1) break;
    await Bun.sleep(16);
  }
  restore();
  process.removeListener('exit', restore);
  output.write('\n');
}
