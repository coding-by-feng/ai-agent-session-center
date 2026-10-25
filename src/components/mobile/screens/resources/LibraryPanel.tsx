/**
 * LibraryPanel — Resources → Library (plan 16): the desktop Library's list on a phone.
 *
 *   [ Search resources                    ]
 *   Skills 48  Commands 31  Rules 12 …  ♡ Favourites  Most used  Plugin & system
 *   SKILLS · 48
 *   ♥ rar                                   181 uses ›
 *     Claude · Global
 *     Retouch the prompt, sketch it…
 *
 * The filters are the desktop's own (`filterResources`, `countByType`): one type at a time,
 * plugin and CLI-shipped items hidden until asked for, search over names, descriptions, paths,
 * tags and abbreviations. The counts are the Mac's, over the sessions shared with this phone.
 */
import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, Chip, EmptyState, ListRow, ListSection } from '../../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { fetchPhoneLibrary } from '@/lib/chat/phoneResourcesApi';
import { resourceItemPath } from '@/lib/chat/phoneRoutes';
import { resourceMeta, rowUses, usageScopeNote, type PhoneProjectRef } from '@/lib/chat/phoneResourcesModel';
import { DEFAULT_FILTERS, RESOURCE_TYPE_LABELS, countByType, emptyStateMessage, filterResources, type ResourceFilters } from '@/lib/resourceFilters';
import { isUsageCounted, sortByUses } from '@/lib/resourceUsage';
import { noteForResource } from '@/lib/skillNotes';
import type { ResourceType } from '@/types/resources';
import type { PhoneLibrary } from '@/types/phoneResources';
import type { RegisterRefresh } from '../ResourcesScreen';
import { useCloudRead } from '../useCloudRead';
import { usePhoneSkillNotes } from './usePhoneSkillNotes';
import styles from '@/styles/modules/mobile/Resources.module.css';

const readLibrary = ({ signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneLibrary(signal);

/** While the Mac scans, the list is read again this often. */
const SCAN_POLL_MS = 2000;

interface LibraryView {
  type: ResourceType;
  query: string;
  favOnly: boolean;
  plugins: boolean;
  byUses: boolean;
}

const DEFAULT_VIEW: LibraryView = { type: 'skill', query: '', favOnly: false, plugins: false, byUses: false };
const VIEW_KEY = 'aasc-phone-resources-library';

/** The view outlives a visit to a resource and back, and a reload; storage can refuse, so it's a convenience. */
function readView(): LibraryView {
  try {
    const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null') as Partial<LibraryView> | null;
    return saved && typeof saved === 'object' ? { ...DEFAULT_VIEW, ...saved } : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function saveView(view: LibraryView): void {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // A private window or a full storage: the view just starts over next time.
  }
}

export default function LibraryPanel({ register }: { register: RegisterRefresh }) {
  const push = usePhoneNavStore((s) => s.push);
  const read = useCloudRead<PhoneLibrary>(readLibrary);
  const notes = usePhoneSkillNotes();
  const [view, setView] = useState<LibraryView>(readView);
  const update = (patch: Partial<LibraryView>) => setView((v) => ({ ...v, ...patch }));
  const { refresh } = read;

  useEffect(() => {
    register(refresh);
    return () => register(null);
  }, [register, refresh]);
  useEffect(() => saveView(view), [view]);

  const scanning = read.data?.state === 'scanning';
  // A failed poll leaves `data` as it was; its new `error` keeps the polling going.
  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(() => void refresh(), SCAN_POLL_MS);
    return () => clearTimeout(timer);
  }, [scanning, refresh, read.data, read.error]);

  const data = read.data;
  const filters: ResourceFilters = { ...DEFAULT_FILTERS, query: view.query, showPluginSystem: view.plugins, notes, favOnly: view.favOnly };
  const projects = useMemo(() => new Map<string, PhoneProjectRef>((data?.projects ?? []).map((p) => [p.id, p])), [data]);
  const resources = data?.resources ?? [];
  const types = countByType(resources, filters).filter((t) => t.count > 0 || t.type === view.type);
  const byName = filterResources(resources, filters, view.type);
  const counted = isUsageCounted(view.type) && !!data?.usage;
  const list = counted && view.byUses ? sortByUses(byName, new Map(Object.entries(data?.usage?.byId ?? {}))) : byName;

  if (!read.loaded) return <EmptyState live title="Loading the Library…" message="Your Mac is reading its resources." />;
  if (!data) {
    return (
      <EmptyState
        title="Couldn’t load the Library"
        message={read.error?.message}
        action={<Button variant="primary" onClick={() => void refresh()}>Try again</Button>}
      />
    );
  }
  if (resources.length === 0) {
    return scanning || data.state === 'idle'
      ? <EmptyState live title="Your Mac is scanning its resources…" message="Skills, commands, rules and the rest show here when it’s done." />
      : <EmptyState title="No resources found" message="Your Mac found no skills, commands or rules it shares with this phone." />;
  }

  return (
    <>
      {read.error && <div className={styles.note}><Banner tone="error" title="Couldn’t refresh">{read.error.message}</Banner></div>}
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.search}
          value={view.query}
          onChange={(e) => update({ query: e.target.value })}
          placeholder="Search resources"
          aria-label="Search resources"
          enterKeyHint="search"
        />
      </div>
      <div className={styles.chips} role="group" aria-label="Type">
        {types.map((t) => (
          <Chip key={t.type} label={t.label} count={t.count} selected={t.type === view.type} onClick={() => update({ type: t.type })} />
        ))}
      </div>
      <div className={styles.chips} role="group" aria-label="Filters">
        <Chip label="♡ Favourites" selected={view.favOnly} onClick={() => update({ favOnly: !view.favOnly })} />
        {counted && <Chip label="Most used" selected={view.byUses} onClick={() => update({ byUses: !view.byUses })} />}
        <Chip label="Plugin & system" selected={view.plugins} onClick={() => update({ plugins: !view.plugins })} />
      </div>
      {list.length === 0 ? (
        <EmptyState title={emptyStateMessage(view.type, filters)} />
      ) : (
        <ListSection header={`${RESOURCE_TYPE_LABELS[view.type]} · ${list.length}`} footer={counted ? usageScopeNote(data.usage?.scope) : undefined}>
          {list.map((r) => {
            const uses = rowUses(r, data.usage);
            const note = noteForResource(notes, r);
            return (
              <ListRow
                key={r.id}
                tall
                title={<>{note?.fav && <span className={styles.fav} aria-label="Favourite">♥</span>}{r.name}</>}
                subtitle={
                  <>
                    <span className={styles.line}>{resourceMeta(r, projects)}</span>
                    {r.description && <span className={styles.line}>{r.description}</span>}
                  </>
                }
                trailing={uses ? <span className={styles.uses} aria-label={uses.label}>{uses.text}</span> : undefined}
                chevron
                onClick={() => push(resourceItemPath(r.id))}
                testId="resource-row"
              />
            );
          })}
        </ListSection>
      )}
    </>
  );
}
