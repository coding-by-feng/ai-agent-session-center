/**
 * Files for a terminal's prompt (Nov 26 2026): pasted (files copied in Finder, a screenshot) or picked with the
 * toolbar's 📎. Each file is streamed raw to POST /api/terminal-files (server/terminalFilesRouter.ts), saved under
 * its own name on the machine the AASC server runs on, and the answered paths are typed at the prompt.
 *
 * The CLI reads that path on the server's machine, so a terminal SSH'd to another host refuses files: the path
 * would not exist where the agent runs.
 */
import { showToast } from '@/components/ui/ToastContainer';
import { isLoopbackHost } from './agentVoice';

/** Per file; the server enforces the same cap. */
export const MAX_TERMINAL_FILE_BYTES = 100 * 1024 * 1024;
/** Per paste or pick. */
export const MAX_TERMINAL_FILES = 20;
/** An upload that takes longer than this says it is uploading. */
const SLOW_UPLOAD_MS = 300;

export interface TerminalUpload {
  paths: string[];
  errors: string[];
}

type Fetch = (input: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

async function uploadOne(file: File, fetchImpl: Fetch): Promise<{ path: string } | { error: string }> {
  try {
    const res = await fetchImpl('/api/terminal-files', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    });
    const json = await res.json().catch(() => ({})) as { path?: unknown; error?: unknown };
    if (res.ok && typeof json.path === 'string') return { path: json.path };
    return { error: `${file.name}: ${typeof json.error === 'string' ? json.error : `upload failed (${res.status})`}` };
  } catch {
    return { error: `${file.name} could not be uploaded` };
  }
}

/** Upload the files one after another; the paths come back in the files' order. */
export async function uploadTerminalFiles(files: File[], fetchImpl: Fetch = fetch as unknown as Fetch): Promise<TerminalUpload> {
  const paths: string[] = [];
  const errors: string[] = [];
  for (const file of files.slice(0, MAX_TERMINAL_FILES)) {
    if (file.size > MAX_TERMINAL_FILE_BYTES) {
      errors.push(`${file.name} is over 100 MB`);
      continue;
    }
    const result = await uploadOne(file, fetchImpl);
    if ('path' in result) paths.push(result.path);
    else errors.push(result.error);
  }
  if (files.length > MAX_TERMINAL_FILES) errors.push(`Only the first ${MAX_TERMINAL_FILES} files were attached`);
  return { paths, errors };
}

/** Why files can't go to this terminal, or null when they can (a local shell, or SSH to this machine). */
export function remoteUploadRefusal(sshHost: string | null | undefined): string | null {
  if (!sshHost || isLoopbackHost(sshHost)) return null;
  return `Files can't be attached here: they would be saved on this server, not on ${sshHost}`;
}

export interface AttachOptions {
  /** The SSH host of the terminal's session, if any. */
  sshHost: string | null | undefined;
  fetchImpl?: Fetch;
}

/** Upload files for the terminal, with toasts for a refusal, a slow upload and each failure. Returns the paths. */
export async function attachTerminalFiles(files: File[], { sshHost, fetchImpl }: AttachOptions): Promise<string[]> {
  if (files.length === 0) return [];
  const refusal = remoteUploadRefusal(sshHost);
  if (refusal) {
    showToast(refusal, 'warning');
    return [];
  }
  const count = Math.min(files.length, MAX_TERMINAL_FILES);
  const slow = setTimeout(() => {
    showToast(count === 1 ? `Uploading ${files[0].name}…` : `Uploading ${count} files…`, 'info');
  }, SLOW_UPLOAD_MS);
  try {
    const { paths, errors } = await uploadTerminalFiles(files, fetchImpl);
    for (const error of errors) showToast(error, 'error');
    return paths;
  } finally {
    clearTimeout(slow);
  }
}
