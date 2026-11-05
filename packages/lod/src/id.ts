const ids = new WeakMap<object, number>();
let next = 0;

/** A number for `value`, the same for the same object only: for keys built of several objects. */
export function idOf(value: object): number {
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = next++));
  return id;
}
