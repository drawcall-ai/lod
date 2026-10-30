/** `values[index]`, throwing where it is missing. */
export function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`index ${index} out of range`);
  return value;
}
