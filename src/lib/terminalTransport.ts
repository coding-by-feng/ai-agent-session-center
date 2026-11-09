/** Close a terminal: the server owns every PTY, so removing its registration kills it. */
export async function closeManagedTerminal(terminalId: string): Promise<void> {
  const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to close terminal registration');
}
