/** Minimal ANSI styling; disabled for pipes, NO_COLOR, and --no-color. */

let enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(on: boolean): void {
  enabled = on;
}

export function color(on: boolean, code: number, text: string): string {
  return on ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const dim = (text: string) => color(enabled, 2, text);
export const bold = (text: string) => color(enabled, 1, text);
export const green = (text: string) => color(enabled, 32, text);
export const red = (text: string) => color(enabled, 31, text);
export const yellow = (text: string) => color(enabled, 33, text);
export const cyan = (text: string) => color(enabled, 36, text);
