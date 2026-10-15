// Lookups that must succeed: they throw where a value is missing instead of letting
// `undefined` flow on. Shared by the pages and the scripts that drive them.

/** `value`, which must be present; `what` names it in the error. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** `list[index]`, which must exist. */
export function at<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`index ${index} outside 0..${list.length - 1}`);
  return value;
}
