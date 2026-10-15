/** Paths are relative to documented adapter roots, never absolute destination authority. */
import { basename, dirname, join, relative } from 'node:path';
import type { PackageManifest } from '../../src/types/cloudResources.js';
import type { GlobalRoots } from '../resourceRoots.js';
import { encodeProjectPath } from '../resourceRoots.js';
import type { InternalResource } from '../resourceScanner.js';
import { isCredentialPath, PACKAGE_SKIP } from '../fsSafe.js';
import { CloudError } from '../cloud/types.js';
export interface ResourceDestination {
  root: string;
  path: string;
  package: boolean;
  label: string;
  files: { manifestPath: string; localPath: string }[];
}
export type AdapterRoots = Pick<GlobalRoots, 'claudeRoot' | 'codexRoot' | 'sharedRoot'>;
const unsupported = () =>
  new CloudError(
    'unsupported_mapping',
    'This agent/type/path has no safe portable adapter on this device.',
    409,
  );
export function safeRelative(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value !== value.normalize('NFC') ||
    /[\\:\u0000-\u001f\u007f]/u.test(value) ||
    value
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          p.endsWith('.') ||
          p.endsWith(' ') ||
          PACKAGE_SKIP.has(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      ) ||
    isCredentialPath(value)
  )
    throw unsupported();
  return value;
}
function adapterRoot(
  m: Pick<PackageManifest, 'agent' | 'kind' | 'scope'>,
  roots: AdapterRoots,
  projectPath?: string,
): string {
  const agentRoot =
    m.agent === 'claude'
      ? roots.claudeRoot
      : m.agent === 'codex'
        ? roots.codexRoot
        : roots.sharedRoot;
  if (m.scope === 'project') {
    if (!projectPath)
      throw new CloudError(
        'project_mapping_required',
        'Choose a mapped local project before installing project resources.',
        409,
      );
    if (m.kind === 'memory') {
      if (m.agent !== 'claude') throw unsupported();
      return join(roots.claudeRoot, 'projects', encodeProjectPath(projectPath), 'memory');
    }
    return projectPath;
  }
  if (m.kind === 'instruction') return agentRoot;
  const dirs = {
    skill: 'skills',
    command: m.agent === 'claude' ? 'commands' : 'prompts',
    rule: 'rules',
    agent: 'agents',
    memory: 'memories',
  };
  if (
    (m.agent === 'shared' && m.kind !== 'skill') ||
    (m.kind === 'agent' && m.agent !== 'claude') ||
    (m.kind === 'memory' && m.agent !== 'codex')
  )
    throw unsupported();
  return join(agentRoot, dirs[m.kind]);
}
export function resourceDestination(
  m: PackageManifest,
  roots: AdapterRoots,
  projectPath?: string,
): ResourceDestination {
  const root = adapterRoot(m, roots, projectPath);
  for (const f of m.files) safeRelative(f.path);
  let owned: string;
  if (m.kind === 'skill') {
    const primary = m.files.filter((f) => f.path.endsWith('/SKILL.md'));
    // Exactly one package root; nested supporting SKILL.md files remain valid beneath it.
    const candidates = primary
      .map((f) => dirname(f.path))
      .filter((p) => m.files.every((f) => f.path.startsWith(p + '/')))
      .sort((a, b) => a.length - b.length);
    owned = candidates[0] ?? '';
    if (
      !owned ||
      basename(owned).startsWith('.') ||
      (m.agent === 'claude' && basename(owned) === 'synced')
    )
      throw unsupported();
    if (m.scope === 'global') {
      if (owned.includes('/')) throw unsupported();
    } else {
      const agent = m.agent === 'shared' ? 'agents' : m.agent;
      const pattern =
        m.agent === 'claude'
          ? /(?:^|\/)\.claude\/skills\/[^/]+$/
          : new RegExp(`^\\.${agent}/skills/[^/]+$`);
      if (!pattern.test(owned)) throw unsupported();
    }
  } else {
    if (m.files.length !== 1) throw unsupported();
    owned = m.files[0].path;
    if (m.kind === 'instruction') {
      const allowed =
        m.agent === 'claude'
          ? ['CLAUDE.md', 'CLAUDE.local.md']
          : m.agent === 'codex'
            ? ['AGENTS.md', 'AGENTS.override.md']
            : [];
      if (
        owned
          .split('/')
          .slice(0, -1)
          .some(
            (p) => p.startsWith('.') && !(m.agent === 'claude' && owned === '.claude/CLAUDE.md'),
          ) ||
        !allowed.includes(basename(owned)) ||
        (m.scope === 'global' && owned.includes('/'))
      )
        throw unsupported();
    } else if (m.kind === 'memory') {
      if (!/\.md$/i.test(owned)) throw unsupported();
    } else if (m.scope === 'project') {
      if (m.agent === 'claude') {
        const category =
          m.kind === 'command' ? 'commands' : m.kind === 'agent' ? 'agents' : 'rules';
        if (!new RegExp(`(?:^|/)\\.claude/${category}/.+\\.md$`, 'i').test(owned))
          throw unsupported();
      } else if (m.agent === 'codex' && m.kind === 'command') {
        if (!/^\.codex\/prompts\/[^/]+\.md$/i.test(owned)) throw unsupported();
      } else throw unsupported();
    } else if (m.kind === 'rule' && m.agent === 'codex') {
      if (!/^[^/]+\.rules$/.test(owned)) throw unsupported();
    } else if (!/\.md$/i.test(owned) || (m.agent === 'codex' && owned.includes('/')))
      throw unsupported();
  }
  return {
    root,
    path: join(root, owned),
    package: m.kind === 'skill',
    label: `${m.agent} ${m.scope} / ${owned}`,
    files: m.files.map((f) => ({
      manifestPath: f.path,
      localPath: m.kind === 'skill' ? f.path.slice(owned.length + 1) : basename(owned),
    })),
  };
}
/** Preserve placement from scanner-owned paths, then independently validate the adapter. */
export function publicationPaths(
  r: InternalResource,
  paths: string[],
  roots: AdapterRoots,
  projectPath?: string,
): string[] {
  const shape = {
    agent: r.summary.agent,
    kind: r.summary.type === 'instructions' ? 'instruction' : r.summary.type,
    scope: r.summary.scope,
  } as Pick<PackageManifest, 'agent' | 'kind' | 'scope'>;
  const root = adapterRoot(shape, roots, projectPath);
  return paths.map((p) =>
    safeRelative(
      relative(root, r.entry.kind === 'package' ? join(r.entry.absPath, p) : r.entry.absPath)
        .split('\\')
        .join('/'),
    ),
  );
}
