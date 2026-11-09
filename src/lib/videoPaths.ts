// videoPaths.ts — where a prompt lists the videos attached to it. Shared by the phone composer
// (lib/chat/videoAttach) and the desktop queue editor, so the desktop never imports the phone's lib/chat.

/** The message text with each video's path on its own line under it. */
export function withVideoPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const body = text.replace(/\s+$/, '');
  return body === '' ? paths.join('\n') : `${body}\n${paths.join('\n')}`;
}
