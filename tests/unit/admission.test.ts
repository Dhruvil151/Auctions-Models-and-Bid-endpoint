import { describe, expect, it } from 'vitest';
import { Admission } from '../../src/shared/admission.js';

describe('bounded admission', () => {
  it('queues work, rejects overflow and releases a permit after failure', async () => {
    const admission = new Admission(1, 1);
    let release!: () => void;
    const active = admission.run(performance.now() + 1000, () => new Promise<void>((resolve) => { release = resolve; }));
    const queued = admission.run(performance.now() + 1000, async () => { throw new Error('work failed'); });
    const failure = expect(queued).rejects.toThrow('work failed');
    await expect(admission.run(performance.now() + 1000, async () => 1)).rejects.toMatchObject({ statusCode: 503 });
    release(); await active; await failure;
    expect(await admission.run(performance.now() + 1000, async () => 2)).toBe(2);
  });

  it('expires queued work without running it', async () => {
    const admission = new Admission(1, 1);
    let release!: () => void; let ran = false;
    const active = admission.run(performance.now() + 1000, () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(admission.run(performance.now() + 10, async () => { ran = true; })).rejects.toMatchObject({ statusCode: 503 });
    expect(ran).toBe(false);
    release(); await active;
    expect(await admission.run(performance.now() + 1000, async () => 3)).toBe(3);
  });
});
