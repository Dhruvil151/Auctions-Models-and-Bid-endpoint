import r from 'rethinkdb';
import './driver-types.js';
import { config } from '../config.js';

/** Driver connections multiplex queries; a small pool avoids a socket per request. */
export class Database {
  private connections: r.Connection[] = [];
  private next = 0;
  constructor(readonly name = config.dbName) {}

  async connect(count = config.dbConnections): Promise<void> {
    try {
      for (let i = 0; i < count; i++) {
        const connection = await r.connect({
          host: config.dbHost, port: config.dbPort, db: this.name,
          user: config.dbUser, password: config.dbPassword, timeout: 5,
        });
        // Request failures surface through run(); avoid an unhandled EventEmitter error.
        connection.on('error', () => {});
        this.connections.push(connection);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async run<T>(query: r.Operation<T>): Promise<T> {
    const connection = this.connections[this.next++ % this.connections.length];
    if (!connection || !connection.open) throw new Error('Database connection unavailable');
    return query.run(connection, { readMode: 'majority' });
  }

  table(name: string): r.Table { return r.db(this.name).table(name); }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((connection) => connection.close()));
    this.connections = [];
  }
}

export function assertWrite(result: { errors: number; first_error?: unknown }): void {
  if (result.errors) throw new Error(String(result.first_error ?? 'Database write failed'));
}
