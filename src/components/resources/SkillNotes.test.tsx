import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceSummary } from '@/types/resources';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import SkillNotes, { FavToggle } from './SkillNotes';

function res(over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: 'a1', type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    name: 'retouch-ascii-review', path: '~/.claude/skills/retouch-ascii-review', fileCount: 1, bytes: 1, mtimeMs: 0,
    repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [], ...over,
  } as ResourceSummary;
}
const REAL = new Set(['claude:retouch-ascii-review', 'claude:plan']);
const notes = () => useSkillNotesStore.getState().notes;
// These control tests model an already-hydrated store; real IndexedDB readiness is
// covered by skillNotesStore.sync.test.ts and the persistent-browser gate.
beforeEach(async()=>{await useSkillNotesStore.getState().flush();useSkillNotesStore.setState({ready:true});});

describe('SkillNotes card', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } useSkillNotesStore.setState({ notes: {} }); });

  it('adds several tags, shows them as chips, and removes one', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Add a tag');
    await user.type(input, 'Review{Enter}');
    await user.type(input, 'workflow{Enter}');
    expect(notes()['claude:retouch-ascii-review'].tags).toEqual(['review', 'workflow']);
    expect(screen.getByText('review')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove tag review' }));
    expect(notes()['claude:retouch-ascii-review'].tags).toEqual(['workflow']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('toggles the favourite, reporting its state to assistive tech', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const fav = screen.getByRole('button', { name: /Favourite/ });
    expect(fav.getAttribute('aria-pressed')).toBe('false');
    await user.click(fav);
    expect(notes()['claude:retouch-ascii-review'].fav).toBe(true);
    expect(screen.getByRole('button', { name: /Favourite/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves an abbreviation and clears it again', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'RAR');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(notes()['claude:retouch-ascii-review'].abbr).toBe('rar');
    await user.click(screen.getByRole('button', { name: 'Clear abbreviation' }));
    expect(notes()).toEqual({});
  });

  it('explains why an abbreviation is refused, and keeps the field', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:other': { fav: false, tags: [], abbr: 'rar' } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'rar');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(screen.getByRole('alert').textContent).toContain('already the abbreviation of other');
    expect((screen.getByLabelText('Abbreviation') as HTMLInputElement).value).toBe('rar');
    expect(notes()['claude:retouch-ascii-review']).toBeUndefined();
  });

  it('refuses the name of a real skill', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'plan');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(screen.getByRole('alert').textContent).toContain('existing skill or command');
  });

  it('labels the active local notes partition', () => {
    render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.getByText(/local notes/i)).toBeTruthy();
  });

  it('keys a plugin skill the way the prompt box names it', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res({ origin: 'plugin', pluginName: 'superpowers', name: 'brainstorming' })} realNames={REAL} />);
    await user.type(screen.getByLabelText('Add a tag'), 'ideas{Enter}');
    expect(Object.keys(notes())).toEqual(['claude:superpowers:brainstorming']);
  });
});

describe('FavToggle', () => {
  beforeEach(() => { useSkillNotesStore.setState({ notes: {} }); });

  it('is a labelled toggle on a row', async () => {
    const user = userEvent.setup();
    render(<FavToggle resource={res()} />);
    const btn = screen.getByRole('button', { name: 'Favourite retouch-ascii-review' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await user.click(btn);
    expect(within(document.body).getByRole('button', { name: 'Favourite retouch-ascii-review' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('renders nothing for a type that cannot have notes', () => {
    const { container } = render(<FavToggle resource={res({ type: 'rule' })} />);
    expect(container.textContent).toBe('');
  });
});

// ── The abbreviation as a real command in Claude Code / Codex ───────────────
describe('SkillNotes card — also work inside the CLI', () => {
  type Call = { url: string; method: string; body: unknown };
  let calls: Call[];
  let respond: (call: Call) => { status?: number; body: unknown };

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar' } } });
    calls = [];
    respond = (call) => ({
      body: { success: true, data: { files: [{ path: `~/.claude/commands/${(call.body as { abbr: string }).abbr}.md`, action: call.method === 'DELETE' ? 'removed' : 'created' }] } },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const r = respond(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const box = () => screen.getByRole('checkbox', { name: /Also work inside Claude Code/ });

  it('offers it only once there is an abbreviation', () => {
    useSkillNotesStore.setState({ notes: {} });
    render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names the CLI and the way to type it, for each agent', () => {
    const { unmount } = render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Claude Code (/rar)' })).toBeTruthy();
    unmount();
    useSkillNotesStore.setState({ notes: { 'codex:x': { fav: false, tags: [], abbr: 'rar' } } });
    const codex = render(<SkillNotes resource={res({ agent: 'codex', name: 'x' })} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Codex ($rar)' })).toBeTruthy();
    codex.unmount();
    useSkillNotesStore.setState({ notes: { 'shared:x': { fav: false, tags: [], abbr: 'rar' } } });
    render(<SkillNotes resource={res({ agent: 'shared', name: 'x' })} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Claude Code and Codex (/rar, $rar)' })).toBeTruthy();
  });

  it('creates the command on tick, lists the files, and remembers it', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    expect(calls).toEqual([{
      url: '/api/resources/aliases', method: 'POST',
      body: { agent: 'claude', kind: 'skill', target: 'retouch-ascii-review', abbr: 'rar' },
    }]);
    expect(await screen.findByText('~/.claude/commands/rar.md')).toBeTruthy();
    expect(notes()['claude:retouch-ascii-review'].cli).toBe(true);
    expect(box()).toBeChecked();
  });

  it('shows the server\'s reason and stays unticked when it refuses', async () => {
    respond = () => ({ status: 409, body: { success: false, error: '~/.claude/commands/rar.md already exists and was not made by AASC; it was left alone.' } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    expect((await screen.findByRole('alert')).textContent).toContain('was not made by AASC');
    expect(box()).not.toBeChecked();
    expect(notes()['claude:retouch-ascii-review'].cli).toBeUndefined();
  });

  it('removes the command on untick', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    await screen.findByText(/Removed/);
    expect(calls).toEqual([{ url: '/api/resources/aliases', method: 'DELETE', body: { agent: 'claude', kind: 'skill', abbr: 'rar' } }]);
    expect(notes()['claude:retouch-ascii-review'].cli).toBeUndefined();
  });

  it('moves the command when the abbreviation changes: new first, then the old one goes', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Abbreviation');
    await user.clear(input);
    await user.type(input, 'rv');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    await screen.findByText('~/.claude/commands/rv.md');
    expect(calls.map((c) => [c.method, (c.body as { abbr: string }).abbr])).toEqual([['POST', 'rv'], ['DELETE', 'rar']]);
    expect(notes()['claude:retouch-ascii-review']).toMatchObject({ abbr: 'rv', cli: true });
  });

  it('keeps the old abbreviation and command when the new one cannot be created', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    respond = () => ({ status: 409, body: { success: false, error: 'nope' } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Abbreviation');
    await user.clear(input);
    await user.type(input, 'rv');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('nope');
    expect(notes()['claude:retouch-ascii-review']).toMatchObject({ abbr: 'rar', cli: true });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('removes the command before clearing the abbreviation', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(screen.getByRole('button', { name: 'Clear abbreviation' }));
    await waitFor(() => expect(notes()).toEqual({}));
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
  });
});

it('disables every note/alias editing control until the selected notes hydrate',()=>{
 useSkillNotesStore.setState({ready:false,sync:{...useSkillNotesStore.getState().sync,state:'off'},notes:{'claude:retouch-ascii-review':{fav:true,tags:['old'],abbr:'rar',cli:true}}});
 render(<SkillNotes resource={res()} realNames={REAL}/>);
 for(const button of screen.getAllByRole('button'))expect(button).toBeDisabled();
 expect(screen.getByLabelText('Add a tag')).toBeDisabled();expect(screen.getByLabelText('Abbreviation')).toBeDisabled();expect(screen.getByRole('checkbox')).toBeDisabled();expect(screen.getByText(/Loading saved notes/)).toBeInTheDocument();
});

describe('cloud CLI intent and local installation are separate', () => {
  const cloudIdentity = {
    backendOrigin: 'https://example.test',
    accountId: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    profileId: 'default',
  };
  let cloudCalls: { url: string; body: any }[];
  beforeEach(() => {
    cloudCalls = [];
    useSkillNotesStore.setState({
      ready: true,
      identity: cloudIdentity,
      connection: cloudIdentity,
      notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar' } },
      message: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        cloudCalls.push({ url, body });
        const data = url.endsWith('/status')
          ? {
              enabled: false,
              connection: {
                backendOrigin: cloudIdentity.backendOrigin,
                accountId: cloudIdentity.accountId,
                generation: 1,
              },
              statuses: [{ key: 'claude:retouch-ascii-review', state: 'disabled' }],
              cached: true,
            }
          : url.endsWith('/device')
            ? { enabled: true }
            : url.endsWith('/preview')
              ? {
                  reviewId: '33333333-3333-4333-8333-333333333333',
                  intents: [{key:'claude:retouch-ascii-review',agent:'claude',target:'retouch-ascii-review',abbr:'rar',cli:true}],
                  enabled: true,
                  cached: false,
                  statuses: [{ key: 'claude:retouch-ascii-review', state: 'disabled' }],
                  changes: [
                    {
                      key: 'claude:retouch-ascii-review',
                      action: 'create',
                      files: ['~/.claude/commands/rar.md'],
                    },
                  ],
                }
              : [{ key: 'claude:retouch-ascii-review', state: 'installed' }];
        return new Response(JSON.stringify({ success: true, data }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await useSkillNotesStore.getState().flush();
    });
    vi.unstubAllGlobals();
    useSkillNotesStore.setState({ identity: null, connection: null });
  });
  it('synced desire never calls the direct local alias writer', async () => {
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Use this abbreviation as a CLI command on my devices/ }),
    );
    expect(notes()['claude:retouch-ascii-review'].cli).toBe(true);
    expect(cloudCalls.some((c) => c.url === '/api/resources/aliases')).toBe(false);
    expect(screen.getByText(/Local result/)).toBeInTheDocument();
  });
  it('device opt-in previews files before explicit reconcile', async () => {
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await screen.findByRole('checkbox', { name: /Install cloud aliases on this device/ });
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Install cloud aliases on this device/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review alias for this device' }));
    await screen.findByText('~/.claude/commands/rar.md');
    expect(cloudCalls.some((c) => c.url.endsWith('/reconcile'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Apply reviewed alias' }));
    await screen.findByText(/Local result: installed/);
    expect(cloudCalls.find((c) => c.url.endsWith('/preview'))?.body).toEqual({
      keys: ['claude:retouch-ascii-review'],
    });
    expect(cloudCalls.find((c) => c.url.endsWith('/reconcile'))?.body).toEqual({
      keys: ['claude:retouch-ascii-review'],
      reviewId: '33333333-3333-4333-8333-333333333333',
    });
  });
  it('active old account cannot review through the new available account', async () => {
    useSkillNotesStore.setState({
      connection: {
        ...cloudIdentity,
        accountId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
      },
    });
    render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.getByRole('button', { name: 'Review alias for this device' })).toBeDisabled();
    expect(cloudCalls).toEqual([]);
  });
});

describe('I2/I3 selection-bound local callbacks and abbreviation drafts',()=>{
 const account={backendOrigin:'https://example.test',accountId:'11111111-1111-4111-8111-111111111111',generation:1,profileId:'default'};
 let resolveAlias:(response:Response)=>void,requests:{method:string;body:any}[];
 const k='claude:retouch-ascii-review';
 beforeEach(()=>{requests=[];useSkillNotesStore.setState({ready:true,identity:null,connection:null,notes:{[k]:{fav:false,tags:[],abbr:'rar',cli:true}},message:null});vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(url!=='/api/resources/aliases')return new Response(JSON.stringify({success:true,data:{enabled:false,connection:account,statuses:[],cached:true}}));requests.push({method:init?.method??'GET',body:JSON.parse(String(init?.body))});return new Promise<Response>(r=>{resolveAlias=r;});}));});
 afterEach(async()=>{cleanup();await act(async()=>{await useSkillNotesStore.getState().flush();});vi.unstubAllGlobals();useSkillNotesStore.setState({identity:null,connection:null});});
 const select=async(identity:any,abbr='bb')=>act(async()=>{const s=useSkillNotesStore.getState();useSkillNotesStore.setState({identity,connection:identity,selectionGeneration:(s.selectionGeneration??0)+1,notes:{[k]:{fav:false,tags:[],abbr}}});});
 const watchMutations=()=>{const {setAbbr,setCli}=useSkillNotesStore.getState();const abbrMutation=vi.fn(setAbbr),cliMutation=vi.fn(setCli);useSkillNotesStore.setState({setAbbr:abbrMutation,setCli:cliMutation});return {abbrMutation,cliMutation,restore:()=>useSkillNotesStore.setState({setAbbr,setCli})};};
 const finish=()=>act(async()=>{resolveAlias(new Response(JSON.stringify({success:true,data:{files:[{path:'~/.claude/commands/rar.md',action:'created'}]}})));});
 it('I2: delayed local create cannot enable the selected cloud note',async()=>{const {abbrMutation,cliMutation,restore}=watchMutations();useSkillNotesStore.setState({notes:{[k]:{fav:false,tags:[],abbr:'rar'}}});render(<SkillNotes resource={res()} realNames={REAL}/>);await userEvent.click(screen.getByRole('checkbox',{name:/Also work inside/}));await select(account);await finish();expect(abbrMutation).not.toHaveBeenCalled();expect(cliMutation).not.toHaveBeenCalled();expect(notes()[k]).toEqual({fav:false,tags:[],abbr:'bb'});expect(requests).toHaveLength(1);restore();});
 it('I2: delayed local removal cannot clear the selected cloud note',async()=>{const {abbrMutation,cliMutation,restore}=watchMutations();render(<SkillNotes resource={res()} realNames={REAL}/>);await userEvent.click(screen.getByRole('button',{name:'Clear abbreviation'}));await select(account);await finish();expect(abbrMutation).not.toHaveBeenCalled();expect(cliMutation).not.toHaveBeenCalled();expect(notes()[k]).toEqual({fav:false,tags:[],abbr:'bb'});restore();});
 it('I2: delayed local replacement cannot rename cloud notes or chain old removal',async()=>{render(<SkillNotes resource={res()} realNames={REAL}/>);await userEvent.clear(screen.getByLabelText('Abbreviation'));await userEvent.type(screen.getByLabelText('Abbreviation'),'rv');await userEvent.click(screen.getByRole('button',{name:'Save abbreviation'}));await select(account);await finish();expect(notes()[k].abbr).toBe('bb');expect(requests).toHaveLength(1);});
 it('I2: leaving and returning to local cannot revive a stale completion',async()=>{useSkillNotesStore.setState({notes:{[k]:{fav:false,tags:[],abbr:'rar'}}});render(<SkillNotes resource={res()} realNames={REAL}/>);await userEvent.click(screen.getByRole('checkbox',{name:/Also work inside/}));await select(account);await select(null,'rar');await finish();expect(notes()[k].cli).toBeUndefined();});
 it.each(['enable', 'disable', 'clear', 'replace'] as const)('I2 round2: microtask selection between run return and %s commit cannot edit cloud notes',async(action)=>{
  const api=await import('@/lib/resourcesApi');
  let resolveRequest!:(value:{files:{path:string;action:'created'}[]})=>void;
  const pending=new Promise<{files:{path:string;action:'created'}[]}>(resolve=>{resolveRequest=resolve;});
  const create=vi.spyOn(api,'createAliasCommand').mockImplementation(()=>pending);
  const remove=vi.spyOn(api,'removeAliasCommand').mockImplementation(()=>pending);
  const watched=watchMutations();
  try {
   if(action==='enable')useSkillNotesStore.setState({notes:{[k]:{fav:false,tags:[],abbr:'rar'}}});
   render(<SkillNotes resource={res()} realNames={REAL}/>);
   if(action==='clear')await userEvent.click(screen.getByRole('button',{name:'Clear abbreviation'}));
   else if(action==='replace'){
    await userEvent.clear(screen.getByLabelText('Abbreviation'));
    await userEvent.type(screen.getByLabelText('Abbreviation'),'rv');
    await userEvent.click(screen.getByRole('button',{name:'Save abbreviation'}));
   }else await userEvent.click(screen.getByRole('checkbox',{name:/Also work inside/}));
   await act(async()=>{
    resolveRequest({files:[{path:'~/.claude/commands/rar.md',action:'created'}]});
    // run's await continuation is queued first. Selection executes before its caller's await continuation.
    queueMicrotask(()=>{
     const state=useSkillNotesStore.getState();
     useSkillNotesStore.setState({identity:account,connection:account,selectionGeneration:state.selectionGeneration+1,notes:{[k]:{fav:false,tags:[],abbr:'bb'}}});
    });
   });
   expect(notes()[k]).toEqual({fav:false,tags:[],abbr:'bb'});
   expect(watched.abbrMutation).not.toHaveBeenCalled();
   expect(watched.cliMutation).not.toHaveBeenCalled();
   expect(create).toHaveBeenCalledTimes(action==='enable'||action==='replace'?1:0);
   expect(remove).toHaveBeenCalledTimes(action==='clear'||action==='disable'?1:0);
   expect(screen.getByLabelText('Abbreviation')).toHaveValue('bb');
  }finally{watched.restore();vi.restoreAllMocks();}
 });
 it('I3: hydration reflects saved abbreviation',async()=>{useSkillNotesStore.setState({ready:false,notes:{}});render(<SkillNotes resource={res()} realNames={REAL}/>);await act(async()=>useSkillNotesStore.setState({ready:true,notes:{[k]:{fav:false,tags:[],abbr:'rv'}}}));expect(screen.getByLabelText('Abbreviation')).toHaveValue('rv');});
 it('I3: account selection resets the draft; same-partition edits stay intact',async()=>{render(<SkillNotes resource={res()} realNames={REAL}/>);await userEvent.clear(screen.getByLabelText('Abbreviation'));await userEvent.type(screen.getByLabelText('Abbreviation'),'draft');await act(async()=>useSkillNotesStore.setState({notes:{[k]:{fav:true,tags:[],abbr:'saved'}}}));expect(screen.getByLabelText('Abbreviation')).toHaveValue('draft');await select(account);expect(screen.getByLabelText('Abbreviation')).toHaveValue('bb');});
});
