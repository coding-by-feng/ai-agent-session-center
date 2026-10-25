// terminalReplies.ts — the bytes a terminal emulator writes back on its own, which are not a person typing.
//
// xterm.js answers the queries a CLI sends at startup (cursor position, mode, kitty keyboard flags, window size,
// colours, the terminal's version) and reports focus when a pane is only clicked. They arrive as `terminal_input`,
// so a person merely watching a booting worker would otherwise count as typing into it (Rulings P4-44 F2, P4-49 N2).
// Only complete replies are recognised; a key (`ESC[A`, `ESC O P`, `ESC[1;5C`, a lone ESC) is never one.

/** Every reply kind, as one alternation (no flags: the callers add them). */
const REPLY_SOURCE = [
  '\\x1b\\[[IO]', // focus in / out
  '\\x1b\\[[?>][\\d;]*c', // Device Attributes (primary, secondary)
  '\\x1b\\[\\d+;\\d+R', // cursor position report
  '\\x1b\\[\\??[\\d;]*\\$y', // DECRQM mode report
  '\\x1b\\[\\?\\d*u', // kitty keyboard flags
  '\\x1b\\[\\d+(?:;\\d+)*t', // window size / position reports
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC colour / title reports, ended by BEL or ST
  '\\x1bP[^\\x1b]*\\x1b\\\\', // DCS replies (XTVERSION), ended by ST
].join('|');

/** `data` without the complete terminal replies in it: what is left is what a person typed (empty when nothing was). */
export function stripTerminalReplies(data: string): string {
  return data.replace(new RegExp(REPLY_SOURCE, 'g'), '');
}
