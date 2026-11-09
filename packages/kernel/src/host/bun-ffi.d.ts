/** The part of Bun's FFI the native group kill uses. Bun supplies the module at run time; Node never loads it. */
declare module "bun:ffi" {
  export const dlopen: (path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, unknown> };
  export const FFIType: { i32: unknown; ptr: unknown };
  export const read: { i32: (pointer: unknown, offset: number) => number };
}
