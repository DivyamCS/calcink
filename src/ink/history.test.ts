import { describe, expect, it } from 'vitest';
import { History } from './history.ts';

describe('History (undo / redo)', () => {
  it('starts empty', () => {
    const h = new History<number>();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo(0)).toBeUndefined();
    expect(h.redo(0)).toBeUndefined();
  });

  it('undoes and redoes a sequence of states', () => {
    const h = new History<string>();
    let state = 'a';
    h.record(state);
    state = 'b';
    h.record(state);
    state = 'c';

    state = h.undo(state) as string;
    expect(state).toBe('b');
    state = h.undo(state) as string;
    expect(state).toBe('a');
    expect(h.canUndo).toBe(false);

    state = h.redo(state) as string;
    expect(state).toBe('b');
    state = h.redo(state) as string;
    expect(state).toBe('c');
    expect(h.canRedo).toBe(false);
  });

  it('a new change after undo discards the redo branch', () => {
    const h = new History<string>();
    h.record('a');
    let state = 'b';
    state = h.undo(state) as string; // back to a, redo has b
    expect(h.canRedo).toBe(true);
    h.record(state);
    state = 'c';
    expect(h.canRedo).toBe(false);
  });

  it('is bounded so long sessions cannot leak memory', () => {
    const h = new History<number>(50);
    for (let i = 0; i < 10_000; i++) h.record(i);
    expect(h.size).toBe(50);
    // the oldest entries were dropped; the newest is still undoable
    expect(h.undo(10_000)).toBe(9_999);
  });

  it('clear() empties both stacks', () => {
    const h = new History<number>();
    h.record(1);
    h.undo(2);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
