/**
 * @module remoteAccess
 * AASC-60 (Remote access): the view model behind RESOURCES -> Cloud -> Remote access, and the two
 * things that page can ask this Mac to do (look again, open the Tailscale app).
 *
 * It owns no state of its own. It puts together what other parts already know:
 *  - this Mac's Tailscale, from the probe (tailscaleStatus.ts);
 *  - whether the Mac has shared its Tailscale address with its AASC Cloud account, from the
 *    publisher. Until one is supplied that reads `unavailable`;
 *  - per paired phone, from the in-memory path log (mobile/phonePathLog.ts): whether the phone has
 *    been sent this Mac's current Tailscale address, and how its last sign-in reached the Mac.
 *
 * The view is built field by field and never spread: a field a probe, a publisher or the device
 * list grows later (a confirm code, say) never reaches the page by accident. Only the fields named
 * in src/types/remoteAccess.ts go out. The page does not read all of them (not `tailscale.tailnet`,
 * `tailscale.dnsName` or `phones[].tailnetSentAt`); they stay in the view for the types to name.
 * Everything here works without a cloud connection.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  PhoneReachView,
  PublishView,
  RemoteAccessView,
  TailscaleStatus,
} from '../../src/types/remoteAccess.js';
import log from '../logger.js';
import type { MobileDeviceView } from '../mobile/deviceAuth.js';
import type { PhonePathLog } from '../mobile/phonePathLog.js';

export interface RemoteAccessDeps {
  probe: { status(opts?: { fresh?: boolean }): Promise<TailscaleStatus> };
  /**
   * Shares this Mac's Tailscale address with its AASC Cloud account. Without one, `publish.state` is `unavailable`.
   *
   * The contract: `view()` never throws and `check()` never rejects, because a cloud fault is a state (`failed`), not an
   * exception. Both calls are guarded here all the same: a publisher that breaks the contract reads `failed` on the page,
   * and a cloud fault never 500s it.
   *
   * `check({ retryRefused: true })` is "Check again": it also asks an account that refused before (403, 404). A publisher's
   * own timer never does.
   */
  publisher?: { view(): PublishView; check(options?: { retryRefused?: boolean }): Promise<PublishView> };
  /** The paired phones, pending and active (`deviceAuth.list()`). Read on every request. */
  devices: () => MobileDeviceView[];
  pathLog: PhonePathLog;
  /** The port this Mac's AASC listens on. */
  port: number;
  /** Whose app launcher to use. Default: this process's platform. */
  platform?: NodeJS.Platform;
  /** Launch the Tailscale app. Default (macOS only): `open -a Tailscale`. Tests always inject this. */
  openApp?: () => Promise<void>;
}

export interface RemoteAccess {
  /** The page as it stands: the probe's cached answer and the publisher's last word. */
  view(): Promise<RemoteAccessView>;
  /** "Check again": a fresh look at Tailscale, then the publisher's own check. */
  refresh(): Promise<RemoteAccessView>;
  /** `unsupported` where this Mac has no app to open from here (anything but macOS). */
  openTailscale(): Promise<'opened' | 'unsupported' | 'failed'>;
}

const execFileAsync = promisify(execFile);

/** `open` returns as soon as the app is launched or brought forward; the timeout only cuts off a stuck one. */
const launchTailscaleApp = async (): Promise<void> => {
  await execFileAsync('open', ['-a', 'Tailscale'], { timeout: 5_000 });
};

const unavailable = (port: number): PublishView => ({ state: 'unavailable', tailnet: null, port, at: null });

const failedPublish = (port: number): PublishView => ({ state: 'failed', tailnet: null, port, at: null });

const publishOf = ({ state, tailnet, port, at }: PublishView): PublishView => ({ state, tailnet, port, at });

/** For each paired phone: has it been sent `address`, and how did its last sign-in reach this Mac. */
function phoneReach(
  devices: readonly MobileDeviceView[],
  address: string | null,
  pathLog: PhonePathLog,
): PhoneReachView[] {
  return devices.flatMap((device): PhoneReachView[] => {
    // deviceAuth.list() never returns a revoked phone; the page has no row for one either way.
    if (device.status === 'revoked') return [];
    const seen = pathLog.view(device.id);
    return [
      {
        id: device.id,
        label: device.label,
        platform: device.platform,
        status: device.status,
        // A Mac with no address has sent nobody one: a phone that was never sent anything (null) is no match.
        hasTailnet: address !== null && seen.tailnetSent === address,
        tailnetSentAt: seen.tailnetSentAt,
        lastPath: seen.lastPath,
        lastPathAt: seen.lastPathAt,
      },
    ];
  });
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createRemoteAccess(deps: RemoteAccessDeps): RemoteAccess {
  const { probe, publisher, devices, pathLog, port } = deps;
  const platform = deps.platform ?? process.platform;
  const openApp = deps.openApp ?? launchTailscaleApp;

  /** What the publisher shows now: `failed` if it throws, since the page is polled and must keep answering. */
  function publishNow(): PublishView {
    if (!publisher) return unavailable(port);
    try {
      return publisher.view();
    } catch (err) {
      // Debug, not warn: the page asks every few seconds, so a broken publisher would flood the log.
      log.debug('remote-access', `The publisher could not report (${reasonOf(err)})`);
      return failedPublish(port);
    }
  }

  /** "Check again" on the publisher: `failed` if it rejects, with the reason in the log and not on the page. */
  async function publishChecked(): Promise<PublishView> {
    if (!publisher) return unavailable(port);
    try {
      return await publisher.check({ retryRefused: true });
    } catch (err) {
      log.warn('remote-access', `Sharing the Tailscale address failed unexpectedly (${reasonOf(err)})`);
      return failedPublish(port);
    }
  }

  function build(tailscale: TailscaleStatus, publish: PublishView): RemoteAccessView {
    return {
      tailscale: {
        state: tailscale.state,
        address: tailscale.address,
        account: tailscale.account,
        tailnet: tailscale.tailnet,
        dnsName: tailscale.dnsName,
        canOpenApp: platform === 'darwin' && tailscale.state !== 'not-installed',
      },
      publish: publishOf(publish),
      phones: phoneReach(devices(), tailscale.address, pathLog),
      port,
    };
  }

  return {
    async view() {
      return build(await probe.status(), publishNow());
    },

    async refresh() {
      // In this order: the publisher reads the address from the probe's cache, which the fresh look just filled.
      const tailscale = await probe.status({ fresh: true });
      return build(tailscale, await publishChecked());
    },

    async openTailscale() {
      if (platform !== 'darwin') return 'unsupported';
      try {
        await openApp();
        return 'opened';
      } catch (err) {
        log.warn('remote-access', `Could not open Tailscale (${reasonOf(err)})`);
        return 'failed';
      }
    },
  };
}
