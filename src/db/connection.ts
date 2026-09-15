import r from 'rethinkdb';
import './driver-types.js';
import { config } from '../config.js';

/** Driver connections multiplex queries; a small pool avoids a socket per request. */
export class Database {
  private connections: r.Connection[] = [];
  private readonly reconnecting = new Map<number, Promise<r.Connection>>();
  private next = 0;
  private closed = false;
  constructor(readonly name = config.dbName) {}

  private async openConnection(): Promise<r.Connection> {
    const connection = await r.connect({
      host: config.dbHost, port: config.dbPort, db: this.name,
      user: config.dbUser, password: config.dbPassword, timeout: 5,
    });
    connection.on('error', () => {});
    return connection;
  }

  async connect(count = config.dbConnections): Promise<void> {
    try {
      for (let i = 0; i < count; i++) {
        this.connections.push(await this.openConnection());
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async run<T>(query: r.Operation<T>): Promise<T> {
    if (this.closed || this.connections.length === 0) throw new Error('Database connection unavailable');
    const index = this.next++ % this.connections.length;
    let connection = this.connections[index]!;
    if (!connection.open) {
      let pending = this.reconnecting.get(index);
      if (!pending) {
        pending = this.openConnection().then(async (fresh) => {
          if (this.closed) { await fresh.close(); throw new Error('Database closed'); }
          this.connections[index] = fresh;
          return fresh;
        }).finally(() => this.reconnecting.delete(index));
        this.reconnecting.set(index, pending);
      }
      connection = await pending;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // A timed-out write has an unknown outcome. Closing this socket bounds
        // outstanding client work; durable idempotency resolves it on retry.
        void connection.close({ noreplyWait: false }).catch(() => {});
        reject(new Error('Database query timed out; outcome may be committed'));
      }, config.dbQueryTimeoutMs);
    });
    try { return await Promise.race([query.run(connection, { readMode: 'majority' }), timeout]); }
    finally { clearTimeout(timer); }
  }

  table(name: string): r.Table { return r.db(this.name).table(name); }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.reconnecting.values());
    await Promise.allSettled(this.connections.map((connection) => connection.close()));
    this.connections = [];
  }
}

export function assertWrite(result: { errors: number; first_error?: unknown }): void {
  if (result.errors) throw new Error(String(result.first_error ?? 'Database write failed'));
}
