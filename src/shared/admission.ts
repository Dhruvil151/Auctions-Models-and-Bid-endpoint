import { unavailable } from './errors.js';

/** Bounded work admission, not a correctness lock or user rate limit. */
export class Admission {
  private active = 0;
  private readonly waiters = new Set<() => void>();
  constructor(private readonly limit: number, private readonly queueLimit: number) {}

  async run<T>(deadline: number, work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiters.size >= this.queueLimit || performance.now() >= deadline) throw unavailable();
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { this.waiters.delete(ready); reject(unavailable()); }, Math.max(1, deadline - performance.now()));
        this.waiters.add(ready);
      });
    } else { this.active++; }
    try {
      if (performance.now() >= deadline) throw unavailable();
      return await work();
    } finally {
      const ready = this.waiters.values().next().value;
      if (ready) { this.waiters.delete(ready); ready(); }
      else { this.active--; }
    }
  }
}
