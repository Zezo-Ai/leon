declare module '@ffprobe-installer/ffprobe' {
  export const path: string
}

/**
 * NLP.js type definitions
 * @see https://github.com/axa-group/nlp.js/tree/master/packages
 */
interface BuiltinMicrosoft<T> {
  new (settings: unknown, container: unknown): T
}
interface Nlp<T> {
  new (settings: unknown, container: unknown): T
}
interface LangAll {
  register(container: unknown)
}

declare module '@nlpjs/core-loader' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const containerBootstrap: () => Promise<any>
}
declare module '@nlpjs/nlp' {
  export const Nlp: Nlp
}
declare module '@nlpjs/builtin-microsoft' {
  export const BuiltinMicrosoft: BuiltinMicrosoft
}
declare module '@nlpjs/lang-all' {
  export const LangAll: LangAll
}

declare module 'better-sqlite3' {
  export interface RunResult {
    changes?: number
    lastInsertRowid?: number | bigint
  }

  export interface Statement {
    run(...params: unknown[]): RunResult
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }

  export interface Database {
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
  }

  export interface DatabaseOptions {
    readonly?: boolean
    fileMustExist?: boolean
    timeout?: number
    verbose?: (...params: unknown[]) => void
  }

  interface DatabaseConstructor {
    new (filename: string, options?: DatabaseOptions): Database
  }

  const Database: DatabaseConstructor
  export default Database
}
