// tools/imageUpload.ts — `image_upload` (the prompts toolset, P2): give AASC a picture to attach to a prompt. It saves
// the picture the way the prompt composer does (`POST /queue-images`, which keeps it 24 hours as a file named by an id)
// and answers that id, for prompt_send's `imageIds`.
//
// AASC itself reads the file a central names, so the rules are the whole of its safety:
//   * the path is under the person's home folder, and so is where it leads once its symlinks are followed (the home
//     folder itself is no file); a path outside home is refused whether or not anything is there, so the refusal says
//     nothing about files outside it;
//   * it is not in ~/Library, nor below a hidden folder or file of home (any segment starting with a dot: ~/.ssh,
//     ~/.config), by the path given or by where it leads: those hold the Mac's own data (Messages attachments, Photos
//     originals, keys), not pictures the person means to share. They are refused in the words of outside home, so the
//     refusal does not say whether the file is there;
//   * it is a plain file: a folder, a named pipe or a device is refused before it is opened (opening a pipe waits for
//     a writer that may never come), and the file is opened without waiting on one swapped in since;
//   * it is a picture by its bytes (png, jpeg, gif, webp), never by its name: a text file called a.png is refused, and
//     a picture called a.dat is taken;
//   * at most 10 MB, checked on the file's size before it is read, and again on what was read;
//   * a refusal never repeats the path, and the answer never gives the path the route stored it at.
// A data URL goes through the same size and type rules. The picture is always sent on re-encoded from the bytes AASC
// checked, labelled with the type they are.
//
// The file reader is `readHomeMedia`, which `note_attach_media` (noteWrite.ts) shares: the same path, file and size
// rules, with its own size limit and the types it takes (pictures, and mp4, mov and webm video).

import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { isWithin } from '../scope.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, oneLine, unwrap } from './define.js';
import { withheld } from './withheldPaths.js';

/** The biggest picture, in bytes. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The longest data URL a picture of that size can be: the longest prefix, and 4 characters of base64 for every 3 bytes. */
const DATA_URL_MAX = 'data:image/webp;base64,'.length + Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

/** How long the route keeps an uploaded picture (apiRouter.ts `QUEUE_IMAGE_TTL_MS`). */
const KEPT_HOURS = 24;

type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

/** What a note may hold besides a picture: video, judged by its bytes like a picture is. */
export type VideoType = 'mp4' | 'mov' | 'webm';

export type MediaType = ImageType | VideoType;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** The `ftyp` brands of still pictures in the same container as mp4 and mov: not video, so never taken as it. */
const PICTURE_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

/** What the bytes are, by their first bytes; null when they are no picture the CLIs take. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** What the bytes are as a picture or a video: mp4 and mov by `ftyp` at byte 4, webm by its EBML header. */
export function sniffMedia(buf: Buffer): MediaType | null {
  const image = sniffImage(buf);
  if (image !== null) return image;
  if (buf.length >= WEBM_MAGIC.length && buf.subarray(0, WEBM_MAGIC.length).equals(WEBM_MAGIC)) return 'webm';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (PICTURE_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  return null;
}

const PICTURE_TYPES: readonly MediaType[] = ['png', 'jpeg', 'gif', 'webp'];

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

/** The wording of the refusals: a picture-only reader says "picture" and keeps its old words. */
interface Words {
  noun: string;
  limit: string;
  notMedia: string;
  notMediaHint: string;
  pass: string;
}

function wordsFor(types: readonly MediaType[], maxBytes: number): Words {
  const mb = `${Math.round(maxBytes / (1024 * 1024))} MB`;
  const picturesOnly = types.every((t) => PICTURE_TYPES.includes(t));
  return picturesOnly
    ? {
        noun: 'picture',
        limit: `A picture is at most ${mb}.`,
        notMedia: 'That is not a png, jpeg, gif or webp picture.',
        notMediaHint: 'Only those four are taken, judged by the file’s bytes.',
        pass: 'Pass the path of a picture file.',
      }
    : {
        noun: 'file',
        limit: `A file is at most ${mb}.`,
        notMedia: 'That is not a png, jpeg, gif or webp picture, nor an mp4, mov or webm video.',
        notMediaHint: 'Only those seven are taken, judged by the file’s bytes.',
        pass: 'Pass the path of a picture or video file.',
      };
}

const tooBig = (w: Words): ToolError =>
  new ToolError('INVALID', w.limit, w.noun === 'picture' ? 'Shrink it, or send a smaller crop.' : 'Use a smaller file.');

const PICTURE_WORDS = wordsFor(PICTURE_TYPES, IMAGE_MAX_BYTES);

const notAPicture = (): ToolError => new ToolError('INVALID', PICTURE_WORDS.notMedia, PICTURE_WORDS.notMediaHint);

const notAFile = (w: Words): ToolError => new ToolError('INVALID', 'That path is not a file.', w.pass);

const outsideHome = (w: Words): ToolError =>
  new ToolError(
    'INVALID',
    'A file must be under the person’s home folder.',
    w.noun === 'picture'
      ? 'Pass a path inside it (absolute, or starting with ~), or send the picture as a data URL.'
      : 'Pass a path inside it (absolute, or starting with ~).',
  );

/** A file-system error as a refusal that says nothing about the path; anything unexpected is left to be an UPSTREAM failure. */
function readFailure(err: unknown, w: Words): never {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new ToolError('NOT_FOUND', 'There is no file at that path.', 'Check the path.');
  if (code === 'EACCES' || code === 'EPERM') throw new ToolError('INVALID', 'AASC cannot read that file.', 'Pick another file.');
  if (code === 'ELOOP') throw new ToolError('INVALID', 'That path is not a plain file.', w.pass);
  throw err;
}

// ---------------------------------------------------------------------------
// Where the bytes come from
// ---------------------------------------------------------------------------

const underHome = (path: string, home: string): boolean => path !== home && isWithin(path, home);

export interface HomeMediaRules {
  /** The biggest file, in bytes. */
  maxBytes: number;
  /** The types the bytes may be; any other is refused. */
  types: readonly MediaType[];
}

/**
 * The bytes of a file under home, checked as the header says: a plain file, at most `maxBytes` (on its size before it is
 * read and on what was read), one of `types` by its bytes. Throws a refusal that never repeats the path.
 */
export async function readHomeMedia(path: string, rules: HomeMediaRules): Promise<{ bytes: Buffer; name: string; type: MediaType }> {
  const w = wordsFor(rules.types, rules.maxBytes);
  const failed = (err: unknown): never => readFailure(err, w);
  if (path.includes('\0')) throw new ToolError('INVALID', 'A path is plain text.', 'Pass the full path of the file.');
  const home = homedir();
  const expanded = path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path;
  if (!isAbsolute(expanded)) {
    throw new ToolError('INVALID', 'A path is absolute, or starts with ~.', 'Pass the full path of the file.');
  }
  const given = resolve(expanded);
  // The words of the path first, so a path outside home is refused the same whether or not a file is there.
  if (!underHome(given, home) || withheld(given, home)) throw outsideHome(w);
  const real = await realpath(given).catch(failed);
  const realHome = await realpath(home).catch(() => home);
  if (!underHome(real, realHome) || withheld(real, realHome)) throw outsideHome(w);
  // A pipe or a device is refused before it is opened: opening one can wait for ever (A-M6).
  if (!(await stat(real).catch(failed)).isFile()) throw notAFile(w);
  // One handle for the size and the bytes, never following a link at the last step and never waiting on a pipe swapped
  // in since the check: the file checked is the file read.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(real, flags).catch(failed);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notAFile(w);
    if (info.size > rules.maxBytes) throw tooBig(w);
    const bytes = await handle.readFile();
    if (bytes.length > rules.maxBytes) throw tooBig(w);
    const type = sniffMedia(bytes);
    if (type === null || !rules.types.includes(type)) throw new ToolError('INVALID', w.notMedia, w.notMediaHint);
    return { bytes, name: basename(real), type };
  } finally {
    await handle.close();
  }
}

/** A picture data URL's bytes: png, jpeg, gif or webp, base64, nothing else. */
const DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

function decodeDataUrl(dataUrl: string): Buffer {
  const match = DATA_URL.exec(dataUrl);
  if (match === null) {
    throw new ToolError('INVALID', 'That is not a picture data URL.', 'It looks like data:image/png;base64,… (png, jpeg, gif or webp).');
  }
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > IMAGE_MAX_BYTES) throw tooBig(PICTURE_WORDS);
  return bytes;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const imageUpload: ToolDef = defineTool({
  name: 'image_upload',
  toolset: 'prompts',
  title: 'Upload a picture for prompts',
  description:
    'Gives AASC a picture to attach to a prompt: a file under the person’s home folder (absolute, or starting with ~), or ' +
    'a data URL. Nothing in ~/Library or below a hidden folder (one whose name starts with a dot) is taken: it is refused ' +
    'like a file outside home. png, jpeg, gif or webp, judged by the bytes and not the name, at most 10 MB. Answers an image id ' +
    'that prompt_send takes in imageIds; AASC keeps the picture for 24 hours. Give a path or a dataUrl, not both.',
  risk: 'write',
  phase: 2,
  input: {
    path: z.string().min(1).max(1_024).optional().describe('A picture file under the person’s home folder: absolute, or starting with ~.'),
    dataUrl: z.string().max(DATA_URL_MAX).optional().describe('Or the picture as a data URL: data:image/png;base64,… (at most 10 MB of picture).'),
    name: z.string().max(255).optional().describe('A name for the picture, for the Mac’s own record.'),
  },
  async run(args, ctx) {
    if ((args.path === undefined) === (args.dataUrl === undefined)) {
      throw new ToolError('INVALID', 'Give a path or a dataUrl, one of the two.', 'A file under home goes by path; anything else as a data URL.');
    }
    const source = args.path !== undefined ? 'file' : 'dataUrl';
    const picture =
      args.path !== undefined
        ? await readHomeMedia(args.path, { maxBytes: IMAGE_MAX_BYTES, types: PICTURE_TYPES })
        : { bytes: decodeDataUrl(args.dataUrl ?? ''), name: 'image' };
    const type = sniffImage(picture.bytes);
    if (type === null) throw notAPicture();
    const name = oneLine(args.name ?? (source === 'file' ? picture.name : `image.${type === 'jpeg' ? 'jpg' : type}`), 120);
    const dataUrl = `data:image/${type};base64,${picture.bytes.toString('base64')}`;
    const body = unwrap<{ ids?: unknown }>(await ctx.client.post('/queue-images', { images: [{ name, dataUrl }] }));
    const ids = isRecord(body) && Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    if (ids.length !== 1) {
      throw new ToolError('UPSTREAM', 'AASC did not keep the picture.', 'Try it once more; if it fails again, tell the person (the details are in the AASC log).');
    }
    const bytes = picture.bytes.length;
    return {
      data: { imageId: ids[0], type, bytes, expiresInHours: KEPT_HOURS },
      summary: `Picture saved as ${ids[0]} (${type}, ${bytes} bytes). Pass it in imageIds to prompt_send; AASC keeps it for ${KEPT_HOURS} hours.`,
      activity: [{ summary: `Uploaded a ${type} image (${bytes} bytes) for prompts.`, detail: { type, bytes, source } }],
    };
  },
});
