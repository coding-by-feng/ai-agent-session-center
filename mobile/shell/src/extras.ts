// extras.ts — the shell's AASC-19 / AASC-21 parts wired into the app: share to a session's queue,
// the biometric lock, push (inert without the Firebase config) and this phone's settings.
// app.ts owns the screens and the boot order; this owns what those parts need between screens.
import { isAllowedNavigation } from './connectionPlan.js';
import { createLockGate, type LockGate } from './lockGate.js';
import type { RawShare, ShellDeps } from './native.js';
import type { TapOutcome } from './notificationTap.js';
import { pushStateNotice } from './pushRegistration.js';
import { createPushWiring, type PushStart } from './pushSetup.js';
import { allowedOrigins, type SavedMac } from './savedMacs.js';
import { loadShareTargets, sendShare, shareProblem } from './shareFlow.js';
import type { Actions, LockView, Screen } from './ui/screen.js';
import { RELOCK_CHOICES, type RelockMinutes } from './biometricLock.js';

export interface ExtrasHost {
  deps: ShellDeps;
  macs(): SavedMac[];
  setMacs(next: SavedMac[]): void;
  screen(): Screen;
  show(next: Screen): void;
  update(patch: Partial<Record<string, unknown>>): void;
  /** Bumps on every screen change: an answer for a screen already left is dropped. */
  gen(): number;
  home(notice?: string | null): Screen;
  pair(notice: string): Screen;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  guard(fn: () => Promise<void>): () => void;
}

export type ExtraActions = Pick<Actions, 'shareTo' | 'shareSession' | 'finishShare' | 'unlock' | 'showPhone' | 'setLockEnabled' | 'setRelockMinutes'>;

const PUSH_OFF_NOTE = 'Notifications aren’t set up in this build of the app yet.';

export function createExtras(host: ExtrasHost) {
  const { deps } = host;
  const lock: LockGate | null = deps.biometric ? createLockGate(deps.biometric, deps.store) : null;
  let lockAvailable = false;
  let afterUnlock: (() => void) | null = null;
  let push: PushStart = { on: false, reason: 'no-push' };
  const offs: Array<() => void> = [];

  const wiring = createPushWiring(deps, {
    macs: host.macs,
    onTapOutcome: (outcome) => onTap(outcome),
    tapStarted: () => void lock?.tapStarted(),
    tapFinished: () => void lock?.tapFinished(),
  });

  function onTap(outcome: TapOutcome): void {
    if (outcome.action === 'shell') {
      host.show(outcome.screen === 'pair' ? host.pair(outcome.message) : host.home(outcome.message));
      return;
    }
    const macs = host.macs();
    const mac = macs.find((m) => m.id === outcome.serverId);
    if (!mac || !isAllowedNavigation(outcome.url, macs)) return;
    host.show({ name: 'connecting', macId: mac.id, back: '/', reauth: false, status: outcome.message ?? `Loading ${mac.name}…` });
    void deps.navigator.allowOrigins(allowedOrigins(macs)).then(() => deps.navigator.go(outcome.url), () => undefined);
  }

  function lockScreen(then: () => void): void {
    afterUnlock = then;
    host.show({ name: 'locked', busy: false, failed: false });
  }

  // ── Share ──────────────────────────────────────────────────────────

  async function loadTargets(mac: SavedMac, share: RawShare): Promise<void> {
    const my = host.gen();
    host.update({ step: 'loading', macId: mac.id, message: null });
    const out = await host.serial(() => loadShareTargets(deps, host.macs(), mac));
    if (my !== host.gen()) return;
    if (!out.ok) {
      if (out.macs) host.setMacs(out.macs);
      host.update({ step: 'error', message: out.message, added: false });
    } else host.update({ step: 'pick-session', origin: out.origin, targets: out.targets, share });
  }

  const actions: ExtraActions = {
    shareTo: (macId) => host.guard(async () => {
      const s = host.screen();
      const mac = host.macs().find((m) => m.id === macId);
      if (s.name === 'share' && mac) await loadTargets(mac, s.share);
    })(),
    shareSession: (sessionId) => host.guard(async () => {
      const s = host.screen();
      if (s.name !== 'share' || s.step !== 'pick-session' || !s.origin) return;
      const mac = host.macs().find((m) => m.id === s.macId);
      if (!mac) return;
      const my = host.gen();
      host.update({ step: 'sending' });
      const result = await sendShare(deps, mac, s.origin, sessionId, s.share);
      if (my !== host.gen()) return;
      host.update({ step: result.status === 'added' ? 'done' : 'error', message: result.message, added: result.status === 'added' });
    })(),
    finishShare: () => host.show(host.home(null)),
    unlock: host.guard(async () => {
      if (!lock || host.screen().name !== 'locked') return;
      host.update({ busy: true, failed: false });
      const ok = await lock.unlock();
      if (!ok) {
        host.update({ busy: false, failed: true });
        return;
      }
      const then = afterUnlock;
      afterUnlock = null;
      then?.();
    }),
    showPhone: () => host.show({ name: 'phone', notice: null }),
    setLockEnabled: (enabled) => host.guard(async () => {
      if (!lock) return;
      lockAvailable = await deps.biometric!.available().catch(() => false);
      const done = await lock.setEnabled(enabled);
      host.update({
        notice: done
          ? (enabled ? 'AASC now asks for your fingerprint, face or screen lock.' : 'The lock is off.')
          : 'The lock stays off: the phone couldn’t confirm it’s you.',
      });
    })(),
    setRelockMinutes: (minutes) => host.guard(async () => {
      const choice = RELOCK_CHOICES.find((m) => m === minutes);
      if (!lock || choice === undefined) return;
      await lock.setRelockMinutes(choice as RelockMinutes);
      host.update({ notice: null });
    })(),
  };

  return {
    actions,

    lockView(): LockView | null {
      if (!lock) return null;
      const s = lock.settings();
      return { available: lockAvailable, enabled: s.enabled, relockAfterMinutes: s.relockAfterMinutes };
    },

    pushNote(): string {
      if (!push.on) return PUSH_OFF_NOTE;
      return pushStateNotice(push.registrar.state())?.text ?? 'Notifications are on.';
    },

    /**
     * Before anything else is shown: settings load, push starts in the background, and the lock
     * asks first when its policy says so. `next` is the rest of the start.
     */
    async start(event: 'launch' | 'resume', awayFrom: number | null, rest: () => Promise<void>): Promise<void> {
      // Push (and so a notification tap) starts only once unlocked: a tap waits for the unlock.
      const next = async (): Promise<void> => {
        void wiring.start().then((p) => { push = p; }, () => undefined);
        await rest();
      };
      if (!lock) return next();
      await lock.load();
      lockAvailable = await deps.biometric!.available().catch(() => false);
      if (deps.lifecycle) {
        offs.push(deps.lifecycle.onPause(() => void lock.paused()));
        offs.push(deps.lifecycle.onResume(() => {
          if (host.screen().name === 'locked') return;
          void lock.check('resume').then((locked) => {
            const back = host.screen();
            if (locked) lockScreen(() => host.show(back));
          });
        }));
      }
      if (await lock.check(event, awayFrom)) lockScreen(() => void next().catch(() => host.show(host.home(null))));
      else await next();
    },

    /** The shared item waiting in the native inbox, as a screen (null: nothing shared). */
    async takeShare(): Promise<boolean> {
      const share = await deps.share?.take().catch(() => null);
      if (!share) return false;
      const problem = shareProblem(share);
      const macs = host.macs();
      const base = { name: 'share', share, macId: null, origin: null, targets: [], message: null, added: false } satisfies Partial<Screen>;
      if (problem) host.show({ ...base, step: 'error', message: problem });
      else if (macs.length === 0) host.show({ ...base, step: 'error', message: 'Pair a Mac first, then share again. Nothing was added.' });
      else if (macs.length > 1) host.show({ ...base, step: 'pick-mac' });
      else {
        host.show({ ...base, step: 'loading', macId: macs[0].id });
        await loadTargets(macs[0], share);
      }
      return true;
    },

    /** A Mac allowed this phone: the one-time notification question (nothing while push is off). */
    approved: (): Promise<void> => wiring.paired().catch(() => undefined),

    dispose(): void {
      offs.forEach((off) => off());
      wiring.dispose();
    },
  };
}

export type Extras = ReturnType<typeof createExtras>;
