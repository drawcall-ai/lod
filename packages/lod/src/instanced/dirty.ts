/** Changed indices, drained as ordered runs without scanning unchanged instances. */
export class Dirty {
  private readonly bits: Uint32Array;
  private readonly words: number[] = [];

  constructor(private readonly count: number) {
    this.bits = new Uint32Array(Math.ceil(count / 32));
  }

  get empty(): boolean {
    return this.words.length === 0;
  }

  add(index: number): void {
    const word = index >>> 5;
    const before = at(this.bits, word);
    this.bits[word] = before | (1 << (index & 31));
    if (before !== 0) return;
    this.words.push(word);
  }

  all(): void {
    this.words.length = 0;
    this.bits.fill(0xffffffff);
    for (let i = 0; i < this.bits.length; i++) this.words.push(i);
    if (this.bits.length > 0 && this.count % 32) this.bits[this.bits.length - 1] = 0xffffffff >>> (32 - (this.count % 32));
  }

  /** End is exclusive. Edits made by the visitor are not supported. */
  drain(visit: (start: number, end: number) => void): void {
    let start = -1;
    let end = -1;
    this.words.sort((a, b) => a - b);
    for (const word of this.words) {
      let bits = at(this.bits, word);
      this.bits[word] = 0;
      while (bits !== 0) {
        const index = word * 32 + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        if (index === end) {
          end++;
          continue;
        }
        if (start >= 0) visit(start, end);
        start = index;
        end = index + 1;
      }
    }
    this.words.length = 0;
    if (start >= 0) visit(start, end);
  }
}

function at(values: Uint32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Dirty: index ${index} out of range`);
  return value;
}
