/**
 * Small object helpers shared across the setup-infra module.
 */

/**
 * Maps `T` to the object type with every `undefined`-valued optional key removed and the remaining
 * keys made required. Lets `omitUndefined` results spread into typed literals under
 * `exactOptionalPropertyTypes` without an `undefined` mismatch.
 */
export type OmitUndefinedKeys<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: Exclude<T[K], undefined>;
};

/**
 * Strip keys whose value is `undefined`. Lets callers build options objects with
 * conditional fields without the `...(x !== undefined ? { x } : {})` spread dance
 * (and without tripping `exactOptionalPropertyTypes`).
 */
export function omitUndefined<T extends Record<string, unknown>>(value: T): OmitUndefinedKeys<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) result[key as string] = value[key];
  }
  return result as OmitUndefinedKeys<T>;
}
