import type { MessageBoxOptions } from 'electron';

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const RLE = '‫';
const PDF = '‬';
const RLM = '‏';

/** One line with Persian or Arabic letters, embedded right to left; a line of Latin (a command, a path) stays as it is. */
function line(s: string): string {
  if (!RTL.test(s) || s.startsWith(RLE)) return s;
  // A quote mark or bracket between two Latin words ("MCP «demo-files»") would join them into one
  // left-to-right run; a right-to-left mark on each side keeps it with the Persian sentence.
  return RLE + s.replace(/([«»()[\]"“”])/g, `${RLM}$1${RLM}`) + PDF;
}

function text(s: string | undefined): string | undefined {
  return s === undefined ? s : s.split('\n').map(line).join('\n');
}

/**
 * Native message boxes lay text out left to right (Windows TaskDialog always does), so a Persian sentence
 * that holds a Latin name ("سرور MCP «demo-files» وصل شود؟") comes out in the wrong order. Embedding each
 * Persian line right to left fixes the order without touching the Latin lines.
 */
export function bidiBox<T extends MessageBoxOptions>(opts: T): T {
  return { ...opts, message: text(opts.message) ?? '', detail: text(opts.detail), buttons: opts.buttons?.map(line) };
}
