// env.d.ts — the one Vite build value the shell reads (no vite/client types needed).
interface ImportMeta {
  readonly env: { readonly MODE: string };
}
