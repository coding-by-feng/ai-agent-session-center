/**
 * fileLinkContext — how a file named in the phone chat opens in the Project tab.
 * The session screen provides it (through ChatView); the chat's Markdown and tool
 * rows read it, so the memoised rows need no new prop. Absent (a chat shown
 * outside a session screen), file names stay plain text.
 */
import { createContext, useContext } from 'react';

export interface ChatFileLinks {
  /** The session's project folder: which paths count as its files. */
  projectPath: string;
  /** Open a file of the project (its path inside it, "/docs/plan.md") in the Project tab. */
  open: (relPath: string) => void;
}

export const FileLinkContext = createContext<ChatFileLinks | null>(null);

export function useChatFileLinks(): ChatFileLinks | null {
  return useContext(FileLinkContext);
}
