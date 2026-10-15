/**
 * copyText — put text on the phone's clipboard (AASC-45). The Mac serves the
 * page over plain http on the LAN, where `navigator.clipboard` doesn't exist
 * (it needs a secure context), so a selected, off-screen textarea and
 * `execCommand('copy')` stand in for it there. Resolves false when neither worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'phone-copy-buffer';
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
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
