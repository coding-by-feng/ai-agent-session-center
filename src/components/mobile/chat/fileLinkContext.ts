/**
 * fileLinkContext — how a file or folder named in the phone chat opens in the Project tab.
 * The session screen provides it (through ChatView); the chat's Markdown and tool
 * rows read it, so the memoised rows need no new prop. Absent (a chat shown
 * outside a session screen), file names stay plain text.
 */
import { createContext, useContext } from 'react';

/** How a tapped name opens (Nov 18 2026): a folder, where on screen it was tapped, and whether it lies outside the project. */
export interface OpenFileOptions {
  kind?: 'dir';
  /** Viewport point of the tap or click: the desktop Reader anchors its chooser there. */
  anchor?: { x: number; y: number };
  /** `path` is absolute and outside the project. Only sent when `openOutside` is set. */
  outside?: boolean;
}

export interface ChatFileLinks {
  /** The session's project folder: which paths count as its files. */
  projectPath: string;
  /** Open a file or folder of the project (its path inside it, "/docs/plan.md") in the Project tab. */
  open: (relPath: string, options?: OpenFileOptions) => void;
  /** Also link paths outside the project (the desktop Reader; a phone may not read them). */
  openOutside?: boolean;
}

export const FileLinkContext = createContext<ChatFileLinks | null>(null);

export function useChatFileLinks(): ChatFileLinks | null {
  return useContext(FileLinkContext);
}

/** The folders the message being drawn names (fileRefs.messageFolders): where its bare file names are looked for first. */
export const MessageFoldersContext = createContext<readonly string[]>([]);
