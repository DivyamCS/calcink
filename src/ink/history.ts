// Undo/redo with snapshots. Strokes are immutable, so a snapshot is just a reference.
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = Math.max(1, limit);
  }

  /** Call before applying a change, with the state being replaced. Clears redo. */
  record(previous: T): void {
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  /** Returns the state to restore, or undefined if there is nothing to undo. */
  undo(current: T): T | undefined {
    if (this.past.length === 0) return undefined;
    const previous = this.past.pop() as T;
    this.future.push(current);
    return previous;
  }

  redo(current: T): T | undefined {
    if (this.future.length === 0) return undefined;
    const next = this.future.pop() as T;
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get size(): number {
    return this.past.length;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}
