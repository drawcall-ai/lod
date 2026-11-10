// The metadata fields of a baked mesh's container, read with validation: anything unexpected fails the decode.

/** The container's files by name. */
export type Files = Record<string, Uint8Array>;

export function fail(why: string, cause?: unknown): never {
  throw new Error(`Invalid baked mesh: ${why}`, { cause });
}

export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected metadata object");
  return Object.fromEntries(Object.entries(value));
};
export const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : fail("expected finite number"));
export const integer = (value: unknown): number => {
  const result = number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fail("expected positive integer");
};
export const boolean = (value: unknown): boolean => (typeof value === "boolean" ? value : fail("expected boolean"));
export const numbers = (value: unknown, count: number): number[] => {
  if (!Array.isArray(value) || value.length !== count) fail(`expected ${count} numbers`);
  return value.map(number);
};
export const file = (files: Files, name: string): Uint8Array => files[name] ?? fail(`missing ${name}`);
