import { EventEmitter } from 'node:events';
import type { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { maskedEcho, question } from '@setup/common/prompts.js';

/** A minimal readline stand-in: `answer` (if given) is delivered, else it stays open. */
function fakeReadline(answer?: string): ReturnType<typeof createInterface> {
  const rl = new EventEmitter() as unknown as ReturnType<typeof createInterface> & {
    question: (q: string, cb: (a: string) => void) => void;
  };
  rl.question = (_q: string, cb: (a: string) => void) => {
    if (answer !== undefined) cb(answer);
  };
  return rl;
}

describe('maskedEcho (hidden-prompt masking)', () => {
  it('masks a printable character with a single asterisk', () => {
    expect(maskedEcho('a')).toBe('*');
    expect(maskedEcho('sk_live_secret')).toBe('*');
  });

  it('passes newlines through so Enter still advances the line', () => {
    expect(maskedEcho('\n')).toBe('\n');
    expect(maskedEcho('\r\n')).toBe('\r\n');
    expect(maskedEcho('\r')).toBe('\r');
  });
});

describe('question (EOF-safe)', () => {
  it('resolves the typed answer', async () => {
    await expect(question(fakeReadline('hello'), 'name')).resolves.toBe('hello');
  });

  it('resolves the default when the answer is blank', async () => {
    await expect(question(fakeReadline(''), 'name', 'dev')).resolves.toBe('dev');
  });

  it('resolves the default on stdin close (EOF) instead of hanging', async () => {
    const rl = fakeReadline(); // never answers
    const pending = question(rl, 'name', 'fallback');
    rl.emit('close');
    await expect(pending).resolves.toBe('fallback');
  });
});
