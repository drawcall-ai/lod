// Checks on the values a cached plan decodes to.

export function cachedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid cached object");
  return Object.fromEntries(Object.entries(value));
}

export function cachedNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid cached number");
  return value;
}

export function cachedNumbers(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error("Invalid cached dimensions");
  return value.map(cachedNumber);
}
