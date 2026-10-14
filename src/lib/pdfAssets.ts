// Vite emits these on the app's own origin. No CDN or external font requests.
const cmaps = import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url',
  import: 'default',
  eager: true,
});
const fonts = import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*', {
  query: '?url',
  import: 'default',
  eager: true,
});
async function bytes(url: unknown) {
  if (typeof url !== 'string') throw new Error('PDF font data is unavailable');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load PDF font data');
  return new Uint8Array(await response.arrayBuffer());
}
export class LocalCMapReader {
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await bytes(cmaps[`/node_modules/pdfjs-dist/cmaps/${name}.bcmap`]),
      compressionType: 1,
    };
  }
}
export class LocalStandardFonts {
  async fetch({ filename }: { filename: string }) {
    return bytes(fonts[`/node_modules/pdfjs-dist/standard_fonts/${filename}`]);
  }
}
