import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The shipped copy mode against a fake terminal: rows as terminalRows gives them.
const source = await readFile(new URL("../defaults/mods/copy-mode/main.js", import.meta.url), "utf8");
const commands: [string, any][] = [];
let screen: any = null;
const values: Record<string, any> = {
  View: class {}, div: () => proxy(), h_flex: () => proxy(),
  run(name: string, args: any) { commands.push([name, args]); },
  focused: () => ({ terminal: "t1" }), closeOverlay() {}, props: () => ({ overlay: "o1" }), theme: () => ({}),
  terminalRows: (_t: string, from: number, count: number) => screen && { ...screen, rows: screen.rows.slice(from, from + count) },
};
function proxy(): any {
  return new Proxy({}, { get: () => () => proxy() });
}
const mod = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace(/^export default class/m, "const CopyMode = class").replace(/^export /gm, "") + "\nreturn { CopyMode, word, head, selectionFor, rowsOf };")(...Object.values(values));

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]|\p{Extended_Pictographic}/u;
// One row per line, padded to `cols`; a wide character takes its cell and an empty one.
function rows(lines: string[], cols = 20, wrapped: number[] = []) {
  return lines.map((line, i) => {
    const cells: { text: string; wide: boolean }[] = [];
    for (const ch of Array.from(new Intl.Segmenter().segment(line), (s) => s.segment)) {
      const wide = WIDE.test(ch);
      cells.push({ text: ch === " " ? "" : ch, wide });
      if (wide) cells.push({ text: "", wide: false });
    }
    while (cells.length < cols) cells.push({ text: "", wide: false });
    return { cells, wrapped: wrapped.includes(i) };
  });
}
const reader = (r: any[]) => mod.rowsOf((from: number, count: number) => ({ rows: r.slice(from, from + count) }));

test("w, b and e split words like vim, Japanese scripts and emoji included", () => {
  const r = reader(rows(["foo, bar 日本語です 🎉!"]));
  const w = (at: any) => mod.word(r, 1, at, "w", false);
  let at = { row: 0, col: 0 };
  const stops = [];
  for (let i = 0; i < 4; i++) stops.push((at = w(at)).col);
  // ",", "bar", "日本語", "です": kanji and hiragana are separate words, as in vim.
  expect(stops).toEqual([3, 5, 9, 15]);
  expect(mod.word(r, 1, { row: 0, col: 15 }, "b", false)).toEqual({ row: 0, col: 9 });
  expect(mod.word(r, 1, { row: 0, col: 9 }, "e", false)).toEqual({ row: 0, col: 13 });
  expect(mod.word(r, 1, { row: 0, col: 0 }, "w", true)).toEqual({ row: 0, col: 5 });
});

test("words continue across a wrapped row and stop at a line the program ended", () => {
  const r = reader(rows(["abc defgh", "ij klm", "next"], 9, [0]));
  expect(mod.word(r, 3, { row: 0, col: 4 }, "w", false)).toEqual({ row: 1, col: 3 });
  expect(mod.word(r, 3, { row: 1, col: 3 }, "w", false)).toEqual({ row: 2, col: 0 });
  expect(mod.word(r, 3, { row: 1, col: 1 }, "b", false)).toEqual({ row: 0, col: 4 });
});

test("a cell in the second half of a wide character means the character", () => {
  const r = reader(rows(["a日本"]));
  expect(mod.head(r, 0, 2)).toBe(1);
  expect(mod.head(r, 0, 4)).toBe(3);
  expect(mod.selectionFor(r, "char", { row: 0, col: 0 }, { row: 0, col: 3 })).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 4 } });
  expect(mod.selectionFor(r, "char", { row: 0, col: 3 }, { row: 0, col: 0 })).toEqual({ start: { row: 0, col: 4 }, end: { row: 0, col: 0 } });
  expect(mod.selectionFor(r, "block", { row: 0, col: 1 }, { row: 1, col: 0 })).toEqual({ start: { row: 0, col: 2 }, end: { row: 1, col: 0 }, rectangle: true });
  expect(mod.selectionFor(r, "line", { row: 0, col: 3 }, { row: 0, col: 1 })).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 19 } });
});

// Timers run at once: the fake terminal already shows the cursor.
const cx: any = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, timer: { after: (_ms: number, f: any) => f(cx) } };
function key(view: any, ch: string, extra: any = {}) {
  view.key({ key: extra.key ?? ch.toLowerCase(), key_char: ch, modifiers: extra.modifiers ?? {} }, cx);
}

test("keys move the cursor, select, and copy on y", () => {
  commands.length = 0;
  screen = { total: 3, top: 0, height: 3, cursor: { row: 1, col: 0 }, selection: null, rows: rows(["first", "日本 x", "third"]) };
  const view = new mod.CopyMode();
  view.init({}, cx);
  expect(commands.shift()).toEqual(["terminal.set_cursor", { terminal: "t1" }]);
  key(view, "v");
  key(view, "2");
  key(view, "l");
  expect(commands.pop()).toEqual(["terminal.set_selection", { terminal: "t1", start: { row: 1, col: 0 }, end: { row: 1, col: 4 } }]);
  expect(commands.pop()).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 1, col: 4 } }]);
  // Before the terminal reports the move, the next key builds on it.
  key(view, "k");
  expect(commands.at(-2)).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 0, col: 4 } }]);
  key(view, "v", { key: "v", modifiers: { control: true } });
  expect(commands.at(-1)![1].rectangle).toBe(true);
  commands.length = 0;
  key(view, "y");
  expect(commands[0]).toEqual(["terminal.copy", undefined]);
});

test("window keys pass through, and count 0 is the line start", () => {
  commands.length = 0;
  screen = { total: 1, top: 0, height: 1, cursor: { row: 0, col: 3 }, selection: null, rows: rows(["  abc"]) };
  const view = new mod.CopyMode();
  view.init({}, cx);
  let stopped = false;
  view.key({ key: "space", key_char: " ", modifiers: { control: true, shift: true } }, { ...cx, stop_propagation() { stopped = true; } });
  expect(stopped).toBe(false);
  view.sent = null;
  key(view, "0");
  expect(commands.at(-1)).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 0, col: 0 } }]);
  view.sent = null;
  key(view, "^");
  expect(commands.at(-1)).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 0, col: 2 } }]);
});

test("keys pressed before the cursor shows wait for it, and a shorter line takes the last character", () => {
  commands.length = 0;
  screen = { total: 2, top: 0, height: 2, cursor: null, selection: null, rows: rows(["ab", "a long line"]) };
  const later: any[] = [];
  const slow = { ...cx, timer: { after: (_ms: number, f: any) => later.push(f) } };
  const view = new mod.CopyMode();
  view.init({}, slow);
  view.key({ key: "k", key_char: "k", modifiers: {} }, slow);
  expect(commands.length).toBe(1);
  screen.cursor = { row: 1, col: 8 };
  later.shift()(slow);
  expect(commands.at(-1)).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 0, col: 1 } }]);
});

test("Esc drops the selection and stays, as in tmux; Esc again leaves", () => {
  commands.length = 0;
  screen = { total: 1, top: 0, height: 1, cursor: { row: 0, col: 0 }, selection: null, rows: rows(["abc"]) };
  let closed = 0;
  const view = new mod.CopyMode();
  view.leave = () => { closed++; };
  view.init({}, cx);
  key(view, "v");
  view.key({ key: "escape", key_char: "", modifiers: {} }, cx);
  expect(view.mode).toBe(null);
  expect(commands.at(-1)).toEqual(["terminal.clear_selection", { terminal: "t1" }]);
  expect(closed).toBe(0);
  view.key({ key: "escape", key_char: "", modifiers: {} }, cx);
  expect(closed).toBe(1);
});

test("a count before gg picks the line", () => {
  commands.length = 0;
  screen = { total: 5, top: 0, height: 5, cursor: { row: 4, col: 0 }, selection: null, rows: rows(["a", "b", "c", "d", "e"]) };
  const view = new mod.CopyMode();
  view.init({}, cx);
  key(view, "3");
  key(view, "g");
  key(view, "g");
  expect(commands.at(-1)).toEqual(["terminal.set_cursor", { terminal: "t1", at: { row: 2, col: 0 } }]);
});
