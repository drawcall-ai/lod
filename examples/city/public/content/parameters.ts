export function choice<T extends string>(query: URLSearchParams, key: string, values: readonly T[], fallback: T): T {
  const value = query.get(key);
  if (value === null) return fallback;
  const found = values.find((item) => item === value);
  if (found === undefined) throw new Error(`Unknown ${key}: ${value}`);
  return found;
}

export function number(query: URLSearchParams, key: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`Invalid ${key}: ${raw}; expected ${integer ? "an integer" : "a number"} in [${min}, ${max}]`);
  return value;
}
