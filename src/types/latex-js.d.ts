declare module 'latex.js' {
  export class HtmlGenerator {
    constructor(opts?: Record<string, unknown>);
  }
  export function parse(
    src: string,
    opts: { generator: HtmlGenerator | unknown },
  ): {
    domFragment(): DocumentFragment;
    htmlDocument(): Document;
  };
}

