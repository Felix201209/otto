declare module 'node:sqlite' {
  export interface StatementSync {
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    setAllowBareNamedParameters?(enabled: boolean): void;
  }

  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
