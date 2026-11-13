/** Serialize default provisioning across windows; keep successful partial work on retry. */
export function defaultSessionInitializer(ensure: (cli: 'claude' | 'codex') => Promise<string>) {
  let pending: Promise<{claude: string; codex: string}> | null = null;
  return () => {
    if (!pending) pending = (async () => ({claude: await ensure('claude'), codex: await ensure('codex')}))().finally(() => { pending = null; });
    return pending;
  };
}
