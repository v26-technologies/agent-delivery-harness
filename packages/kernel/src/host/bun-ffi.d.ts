/** The part of Bun's FFI the native group kill uses, for this repository's typecheck only: it is not published,
 * and it goes if this repository ever takes `@types/bun`. Bun supplies the module at run time; Node never loads it. */
declare module "bun:ffi" {
  export const dlopen: (path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, unknown> };
  export const FFIType: { i32: unknown; ptr: unknown };
  export const read: { i32: (pointer: unknown, offset: number) => number };
}
