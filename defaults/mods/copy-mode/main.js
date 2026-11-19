// Copy mode: move a cursor over the focused terminal's screen and history with
// vi keys, select characters (v or Space), lines (V) or a block (Ctrl+V), and
// copy with y or Enter. Esc drops a selection; q, Ctrl+C or Esc without one
// leave. The terminal stays live; its view doesn't move while output arrives.
// Opened by mod.open:copy-mode.

import { View, div } from "gpui-kit";
import { run, focused, terminalRows, closeOverlay, props } from "herdr";

// A command sent this recently may not have reached the terminal yet: build on
// what it asked for, not on what the terminal reports.
const SETTLE_MS = 200;

// Word classes, as vim splits words: blank, punctuation, word characters, and
// Japanese scripts and emoji each on their own.
const BLANK = 0, PUNCT = 1, WORD = 2;
function wordClass(text, big) {
  if (text === "" || /^\s+$/u.test(text)) return BLANK;
  if (big) return WORD;
  if (/^[\p{L}\p{N}_]/u.test(text)) {
    if (/^\p{Script=Han}/u.test(text)) return 3;
    if (/^\p{Script=Hiragana}/u.test(text)) return 4;
    if (/^[\p{Script=Katakana}ー]/u.test(text)) return 5;
    return WORD;
  }
  if (/^\p{Extended_Pictographic}/u.test(text)) return 6;
  return PUNCT;
}

// Terminal rows read on demand, in chunks, for one key press.
export function rowsOf(read) {
  const cache = new Map();
  return (row) => {
    if (!cache.has(row)) {
      const from = row - (row % 50);
      (read(from, 50)?.rows ?? []).forEach((r, i) => cache.set(from + i, r));
    }
    return cache.get(row) ?? { cells: [], wrapped: false };
  };
}

/** The first cell of the character at col: the second half of a wide one steps back. */
export function head(rows, row, col) {
  const cells = rows(row).cells;
  col = Math.max(0, Math.min(col, cells.length - 1));
  return col > 0 && cells[col]?.text === "" && cells[col - 1]?.wide ? col - 1 : col;
}

function lastText(cells) {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i].text !== "") return i;
  return 0;
}

// Characters in reading order across rows; a row the terminal didn't wrap ends
// in a blank, so words don't run into the next line.
function step(rows, total, at, dir) {
  let { row, col } = at;
  const cells = rows(row).cells;
  if (dir > 0) {
    if (col >= cells.length) return row + 1 < total ? { row: row + 1, col: 0 } : null;
    col += cells[col]?.wide ? 2 : 1;
    if (col >= cells.length) {
      if (row + 1 >= total) return null;
      return rows(row).wrapped ? { row: row + 1, col: 0 } : { row, col: cells.length, eol: true };
    }
    return { row, col };
  }
  if (col === 0) {
    if (row === 0) return null;
    const above = rows(row - 1);
    return above.wrapped ? { row: row - 1, col: head(rows, row - 1, above.cells.length - 1) } : { row: row - 1, col: above.cells.length, eol: true };
  }
  if (col >= cells.length) return { row, col: head(rows, row, cells.length - 1) };
  return { row, col: head(rows, row, col - 1) };
}

function classAt(rows, at, big) {
  if (at.eol || at.col >= rows(at.row).cells.length) return BLANK;
  return wordClass(rows(at.row).cells[at.col].text, big);
}

/** vi word motions: w, b, e (big: W, B, E). */
export function word(rows, total, at, motion, big) {
  let p = { row: at.row, col: at.col };
  if (motion === "w") {
    const start = classAt(rows, p, big);
    let n;
    while (start !== BLANK && (n = step(rows, total, p, 1)) && classAt(rows, n, big) === start) p = n;
    while ((n = step(rows, total, p, 1))) {
      p = n;
      if (classAt(rows, p, big) !== BLANK) return p;
    }
    return land(rows, p);
  }
  if (motion === "e") {
    let n = step(rows, total, p, 1);
    if (!n) return p;
    p = n;
    while (classAt(rows, p, big) === BLANK && (n = step(rows, total, p, 1))) p = n;
    const cls = classAt(rows, p, big);
    while ((n = step(rows, total, p, 1)) && classAt(rows, n, big) === cls) p = n;
    return land(rows, p);
  }
  let n = step(rows, total, p, -1);
  if (!n) return p;
  p = n;
  while (classAt(rows, p, big) === BLANK && (n = step(rows, total, p, -1))) p = n;
  const cls = classAt(rows, p, big);
  while ((n = step(rows, total, p, -1)) && classAt(rows, n, big) === cls) p = n;
  return land(rows, p);
}

function land(rows, p) {
  return { row: p.row, col: head(rows, p.row, p.col) };
}

/** The selection a mode makes between anchor and cursor, with wide characters covered whole. */
export function selectionFor(rows, mode, anchor, cursor) {
  const width = (p) => (rows(p.row).cells[p.col]?.wide ? 1 : 0);
  const after = (a, b) => a.row > b.row || (a.row === b.row && a.col > b.col);
  if (mode === "line") {
    const down = cursor.row >= anchor.row;
    const last = (row) => Math.max(0, rows(row).cells.length - 1);
    return {
      start: { row: anchor.row, col: down ? 0 : last(anchor.row) },
      end: { row: cursor.row, col: down ? last(cursor.row) : 0 },
    };
  }
  if (mode === "block") {
    const right = anchor.col >= cursor.col ? "start" : "end";
    const s = { ...anchor }, e = { ...cursor };
    if (right === "start") s.col += width(anchor); else e.col += width(cursor);
    return { start: s, end: e, rectangle: true };
  }
  const s = { ...anchor }, e = { ...cursor };
  if (after(cursor, anchor)) e.col += width(cursor); else s.col += width(anchor);
  return { start: s, end: e };
}

export default class CopyMode extends View {
  init(_props, cx) {
    this.terminal = focused()?.terminal ?? null;
    this.mode = null;
    this.count = "";
    this.prefix = "";
    this.want = null;
    this.started = false;
    this.sent = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.waiting = [];
    // The app's Esc closes the overlay before our key handler sees it: a binding
    // of our own, deeper in, comes first.
    try {
      cx.bind_keys([{ keystroke: "escape", action: "copy_mode_escape", context: "CopyMode" }]);
    } catch {}
    if (!this.terminal) return closeOverlay(props().overlay);
    run("terminal.set_cursor", { terminal: this.terminal });
    cx.timer.after(30, (cx) => this.start(cx, 100));
  }

  // Keys pressed before the cursor shows wait for it, then run in order.
  start(cx, tries) {
    if (this.state()?.cursor) {
      this.started = true;
      for (const e of this.waiting.splice(0)) this.key(e, cx);
      return;
    }
    if (tries > 0) cx.timer.after(30, (cx) => this.start(cx, tries - 1));
    else this.leave(false);
  }

  state() {
    return terminalRows(this.terminal, 0, 0);
  }

  // The cursor and anchor to build on: the ones just asked for while the
  // terminal catches up, else where it says they are now (output and pruned
  // history move them with their text).
  where(view) {
    if (this.sent && Date.now() - this.sent.at < SETTLE_MS) return this.sent;
    const start = view.selection?.start;
    return { cursor: view.cursor, anchor: this.mode && start ? start : null };
  }

  send(cursor, anchor) {
    const rows = this.rows;
    cursor = { row: cursor.row, col: head(rows, cursor.row, cursor.col) };
    run("terminal.set_cursor", { terminal: this.terminal, at: cursor });
    if (this.mode && anchor) {
      anchor = { row: anchor.row, col: head(rows, anchor.row, anchor.col) };
      run("terminal.set_selection", { terminal: this.terminal, ...selectionFor(rows, this.mode, anchor, cursor) });
    }
    this.sent = { cursor, anchor, at: Date.now() };
  }

  leave(copy) {
    if (copy && this.mode) run("terminal.copy");
    closeOverlay(props().overlay);
  }

  async close() {
    if (!this.terminal) return;
    run("terminal.set_cursor", { terminal: this.terminal, at: null });
    run("terminal.clear_selection", { terminal: this.terminal });
    run("terminal.scroll", { terminal: this.terminal, to: "bottom" });
  }

  // As in tmux, Esc drops the selection first; with none it leaves.
  escape() {
    if (!this.mode) return this.leave(false);
    this.mode = null;
    run("terminal.clear_selection", { terminal: this.terminal });
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    // Window keys (Alt, Cmd, Ctrl+Shift: this mode's own toggle too) still work.
    if (m.alt || m.platform || (m.control && m.shift)) return;
    cx.stop_propagation();
    const view = this.state();
    if (!view) return this.leave(false);
    if (!this.started) return void this.waiting.push(e);
    // Gone: the terminal ended or a program switched screens.
    if (!view.cursor && !this.sent) return this.leave(false);
    const ch = e.key_char ?? "";
    const ctrl = m.control;
    if (e.key === "escape") return this.escape();
    if ((ch === "q" && !ctrl) || (ctrl && e.key === "c")) return this.leave(false);
    if (e.key === "enter" || (ch === "y" && !ctrl)) return this.leave(true);
    if (!ctrl && /^[0-9]$/.test(ch) && (this.count || ch !== "0")) {
      this.count += ch;
      return;
    }
    const n = Math.max(1, parseInt(this.count || "1", 10));
    const counted = this.count !== "";
    this.count = "";
    this.rows = rowsOf((from, count) => terminalRows(this.terminal, from, count));
    const { cursor, anchor } = this.where(view);
    const last = Math.max(0, view.total - 1);
    const at = (row, col) => ({ row: Math.max(0, Math.min(row, last)), col });
    // As in vi, a shorter line takes the cursor to its last character.
    const vertical = (row) => {
      const target = at(row, 0);
      return at(target.row, Math.min(this.want ?? cursor.col, lastText(this.rows(target.row).cells)));
    };
    let next = null, keepWant = false, scroll = 0;

    const toggle = (mode) => {
      if (this.mode === mode) {
        this.mode = null;
        run("terminal.clear_selection", { terminal: this.terminal });
        return;
      }
      const from = this.mode && anchor ? anchor : cursor;
      this.mode = mode;
      this.send(cursor, from);
    };
    if (ctrl && e.key === "v") return toggle("block");
    if (!ctrl && ch === "v") return toggle("char");
    if (!ctrl && ch === " ") return toggle("char");
    if (!ctrl && ch === "V") return toggle("line");

    if (this.prefix === "g") {
      this.prefix = "";
      if (ch === "g") next = at(counted ? n - 1 : 0, 0);
    } else if (ctrl) {
      const half = Math.max(1, Math.floor(view.height / 2));
      const lines = { u: -half, d: half, b: -view.height, f: view.height, y: -1, e: 1 }[e.key];
      if (lines) {
        scroll = lines * n;
        next = vertical(cursor.row + (e.key === "y" || e.key === "e" ? 0 : scroll));
        keepWant = true;
      }
    } else {
      switch (ch) {
        case "h": next = at(cursor.row, Math.max(0, cursor.col - n)); break;
        case "l": {
          let col = cursor.col;
          for (let i = 0; i < n; i++) col += this.rows(cursor.row).cells[col]?.wide ? 2 : 1;
          next = at(cursor.row, Math.min(col, Math.max(0, this.rows(cursor.row).cells.length - 1)));
          break;
        }
        case "j": next = vertical(cursor.row + n); keepWant = true; break;
        case "k": next = vertical(cursor.row - n); keepWant = true; break;
        case "0": next = at(cursor.row, 0); break;
        case "^": next = at(cursor.row, Math.max(0, this.rows(cursor.row).cells.findIndex((c) => c.text.trim() !== ""))); break;
        case "$": next = at(cursor.row, lastText(this.rows(cursor.row).cells)); break;
        case "G": next = at(counted ? n - 1 : last, 0); break;
        case "H": next = vertical(view.top + (counted ? n - 1 : 0)); break;
        case "M": next = vertical(view.top + Math.floor((view.height - 1) / 2)); break;
        case "L": next = vertical(view.top + view.height - 1 - (counted ? n - 1 : 0)); break;
        // The count waits for the second g (3gg).
        case "g": this.prefix = "g"; this.count = counted ? String(n) : ""; return;
        case "w": case "b": case "e": case "W": case "B": case "E": {
          next = cursor;
          for (let i = 0; i < n; i++) next = word(this.rows, view.total, next, ch.toLowerCase(), ch !== ch.toLowerCase());
          break;
        }
      }
    }
    if (!next) return;
    if (keepWant) this.want ??= cursor.col; else this.want = null;
    if (scroll) run("terminal.scroll", { terminal: this.terminal, lines: scroll });
    this.send(next, anchor);
  }

  // Draws nothing: the copy cursor and the selection show the mode. The
  // overlay only holds the keyboard.
  render() {
    return div()
      .id("copy-mode")
      .size_full()
      .track_focus(this.handle)
      .key_context("CopyMode")
      .on_action("copy_mode_escape", () => this.escape())
      .on_key_down((e, cx) => this.key(e, cx));
  }
}
