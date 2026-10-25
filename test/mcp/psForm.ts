// test/mcp/psForm.ts — what the hook stores of a launch line: the live CLI's `ps -o args=`, which is the first command's
// argv once a shell has read the line, joined with spaces. The quotes are gone (a `-n "My title"` comes back as
// `-n My title`), and a `a || b` fallback leaves only the half that ran. Only as much shell as AASC's own launch lines
// use: single and double quotes, backslash escapes, and the separators that end the first command.

/** The `ps` args a shell would leave of `line`'s first command. */
export function psFormOf(line: string): string {
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && '\\$`"'.includes(line[i + 1] ?? '')) word += line[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\') {
      word += line[++i] ?? '';
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) argv.push(word);
      word = '';
      inWord = false;
      continue;
    }
    if (';&|\r\n'.includes(ch)) break;
    word += ch;
    inWord = true;
  }
  if (inWord) argv.push(word);
  return argv.join(' ');
}
