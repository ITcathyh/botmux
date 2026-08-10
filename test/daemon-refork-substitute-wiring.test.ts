import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('daemon residual stopped-session wiring', () => {
  it('clears stale multi-Riff repo state when doc-watch replaces a stopped session cwd', () => {
    const source = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const start = source.indexOf('if (sub.workingDir && (!ds.worker || ds.worker.killed))');
    const end = source.indexOf('\n  }', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('ds.session.riffRepoDirs = undefined');
  });
});
