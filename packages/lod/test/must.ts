/** `value`, failing the test where it is missing: a checked `!`. */
export function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}
