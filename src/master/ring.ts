/** Fixed-size history of numbers (newest last), for scrolling traces. */
export class Ring {
  private readonly data: Float64Array;
  private next = 0;
  private count = 0;

  constructor(size: number) {
    this.data = new Float64Array(size);
  }

  get size(): number {
    return this.data.length;
  }

  push(x: number): void {
    this.data[this.next] = x;
    this.next = (this.next + 1) % this.data.length;
    this.count = Math.min(this.count + 1, this.data.length);
  }

  values(): number[] {
    const start = (this.next - this.count + this.data.length) % this.data.length;
    return Array.from({ length: this.count }, (_, i) => this.data[(start + i) % this.data.length]);
  }

  clear(): void {
    this.next = 0;
    this.count = 0;
  }
}
