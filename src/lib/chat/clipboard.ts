/**
 * clipboard.ts — copy text from the phone chat (AASC-41): code blocks, answers.
 *
 * `navigator.clipboard` exists only in a secure context, and the phone app loads
 * the Mac's page over plain http on the LAN, so it falls back to a hidden textarea
 * and `execCommand('copy')`, which iOS and Android web views still honour inside a
 * tap. Resolves false when neither worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, not focused): try the old way.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    area.style.fontSize = '16px'; // iOS zooms into a smaller field
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
