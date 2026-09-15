import 'rethinkdb';

// The official driver supports these APIs; its community declarations lag behind it.
declare module 'rethinkdb' {
  interface Operation<T> {
    run(connection: Connection, options: Partial<OperationOptions>): Promise<T>;
  }
  interface Expression<T> {
    toISO8601(): Expression<string>;
  }
}
