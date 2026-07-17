// Minimal typings for the browser build of mammoth (no bundled types / @types).
// Only the surface we use: convertToHtml({ arrayBuffer }) → { value, messages }.
declare module 'mammoth/mammoth.browser' {
  interface MammothMessage {
    type: string;
    message: string;
  }
  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  interface MammothInput {
    arrayBuffer: ArrayBuffer;
  }
  interface MammothOptions {
    styleMap?: string | string[];
  }
  export function convertToHtml(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult>;
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
  const mammoth: {
    convertToHtml: typeof convertToHtml;
    extractRawText: typeof extractRawText;
  };
  export default mammoth;
}
