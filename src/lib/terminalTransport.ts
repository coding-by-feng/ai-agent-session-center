/** Close a terminal through the transport that owns it, then remove its server registration. */
export async function closeManagedTerminal(terminalId: string): Promise<void> {
  if (terminalId.startsWith('pty-') && window.electronAPI?.killPty) {
    const result = await window.electronAPI.killPty(terminalId);
    if (!result.ok) throw new Error('Failed to close Electron terminal');
  }

  const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to close terminal registration');
}
