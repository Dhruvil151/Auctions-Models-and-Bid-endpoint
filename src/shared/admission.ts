import { unavailable } from './errors.js';

type Key = string | symbol;
interface Waiter { ready: () => void }

/** Bounded scheduling reduces local hot-auction contention. Database CAS remains
 * authoritative: independent processes have independent schedulers. */
export class Admission {
  private readonly activeKeys = new Set<Key>();
  private readonly queues = new Map<Key, Set<Waiter>>();
  private queued = 0;
  constructor(private readonly limit: number, private readonly queueLimit: number) {}

  private drain(): void {
    for (const [key, queue] of this.queues) {
      if (this.activeKeys.size >= this.limit) break;
      if (this.activeKeys.has(key)) continue;
      const waiter = queue.values().next().value!;
      queue.delete(waiter);
      if (queue.size === 0) this.queues.delete(key);
      this.queued--;
      this.activeKeys.add(key);
      waiter.ready();
    }
  }

  async run<T>(deadline: number, work: () => Promise<T>, key: Key = Symbol()): Promise<T> {
    if (performance.now() >= deadline) throw unavailable();
    if (this.activeKeys.size < this.limit && !this.activeKeys.has(key)) {
      this.activeKeys.add(key);
    } else {
      if (this.queued >= this.queueLimit) throw unavailable();
      await new Promise<void>((resolve, reject) => {
        const queue = this.queues.get(key) ?? new Set<Waiter>();
        const waiter = { ready: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          queue.delete(waiter);
          if (queue.size === 0) this.queues.delete(key);
          this.queued--;
          reject(unavailable());
        }, Math.max(1, deadline - performance.now()));
        queue.add(waiter);
        this.queues.set(key, queue);
        this.queued++;
      });
    }
    try {
      if (performance.now() >= deadline) throw unavailable();
      return await work();
    } finally {
      this.activeKeys.delete(key);
      this.drain();
    }
  }
}
