/**
 * ConversationHits — the Sessions search's second list (Oct 20 2026): where the query
 * appears in what the live sessions said and did (prompts, answers, tool calls),
 * as the desktop's ⇧⌘F search finds it (lib/sessionContentSearch). A row opens the
 * session; its line is clipped around the hit and marks it by the shared rule.
 */
import { ListRow, ListSection } from '../kit';
import Highlighted from '../project/Highlighted';
import { clipToMatch, normalizeQuery } from '@/lib/textHighlight';
import type { ContentField, ContentHit } from '@/lib/sessionContentSearch';

/** How many hits the list shows: enough to find one, few enough to scroll past. */
export const CONTENT_HITS_SHOWN = 30;

const FIELD_WORDS: Record<ContentField, string> = { prompt: 'Prompt', response: 'Answer', tool: 'Tool', event: 'Event' };

export default function ConversationHits({ hits, query, onOpen }: {
  hits: readonly ContentHit[];
  query: string;
  onOpen: (sessionId: string) => void;
}) {
  const q = normalizeQuery(query);
  return (
    <ListSection
      header="In conversations"
      footer={hits.length >= CONTENT_HITS_SHOWN ? `The first ${CONTENT_HITS_SHOWN}. Type more to narrow them.` : undefined}
    >
      {hits.map((hit, i) => (
        <ListRow
          key={`${hit.sessionId}:${hit.field}:${hit.timestamp}:${i}`}
          title={hit.sessionTitle}
          value={FIELD_WORDS[hit.field]}
          subtitle={<Highlighted text={clipToMatch(hit.snippet.replace(/\s+/g, ' '), q, { leading: 40, trailing: 120 })} query={query} />}
          tall
          chevron
          onClick={() => onOpen(hit.sessionId)}
        />
      ))}
    </ListSection>
  );
}
