// pushChannels.ts — how the OS presents each kind of notification (AASC-19).
//
// Android: the channel ids MUST equal the backend's FCM_CHANNELS (aasc-backend
// src/services/push/payload.ts: approval, input, finished, interrupted; a test
// notification uses finished), or Android drops the notification into a
// fallback channel. Once a channel exists only the user can change its
// importance, so a change here needs a new channel id. Every channel is PRIVATE
// on the lock screen: the content shows only after unlocking.
//
// iOS: the backend sets the interruption level (time-sensitive for approval and
// input) and thread-id = the session ref; local notifications use the same
// values so they group with remote ones. Each kind has a category whose
// hidden-preview placeholder is the generic text, and no actions: an action like
// "Approve" would have to require unlock (plan 08 §5), so none exist in v1.
import type { PushArrival, PushKind } from './pushPayload.js';
import { GENERIC_TEXT } from './pushPayload.js';

/** Capacitor PushNotifications.createChannel(): importance 3 = default, 4 = high; visibility 0 = private. */
export interface AndroidChannel {
  id: string;
  name: string;
  description: string;
  importance: 3 | 4;
  visibility: 0;
  vibration: boolean;
  lights: boolean;
}

export const ANDROID_CHANNELS: readonly AndroidChannel[] = [
  { id: 'approval', name: 'Approval needed', description: 'A session is waiting for you to allow a tool', importance: 4, visibility: 0, vibration: true, lights: true },
  { id: 'input', name: 'Waiting for input', description: 'A session asked you a question', importance: 4, visibility: 0, vibration: true, lights: true },
  { id: 'finished', name: 'Finished', description: 'A session finished its turn', importance: 3, visibility: 0, vibration: false, lights: false },
  { id: 'interrupted', name: 'Interrupted', description: 'A session stopped on an error (overload, rate limit, network)', importance: 4, visibility: 0, vibration: true, lights: false },
];

/** = the backend's FCM_CHANNELS. */
export function androidChannelFor(kind: PushKind): string {
  return kind === 'test' ? 'finished' : kind;
}

export type InterruptionLevel = 'time-sensitive' | 'active';

export interface IosCategory {
  identifier: string;
  /** UNNotificationCategory.hiddenPreviewsBodyPlaceholder: shown when previews are hidden. */
  hiddenPreviewsBodyPlaceholder: string;
  actions: readonly never[];
}

export function iosCategoryId(kind: PushKind): string {
  return `AASC_${kind.toUpperCase()}`;
}

export const IOS_CATEGORIES: readonly IosCategory[] = (['approval', 'input', 'finished', 'interrupted', 'test'] as const).map(
  (kind) => ({ identifier: iosCategoryId(kind), hiddenPreviewsBodyPlaceholder: GENERIC_TEXT[kind], actions: [] }),
);

export interface IosPresentation {
  /** UNNotificationContent.threadIdentifier */
  threadIdentifier: string;
  /** UNNotificationContent.interruptionLevel (needs the Time Sensitive capability) */
  interruptionLevel: InterruptionLevel;
  /** UNNotificationContent.categoryIdentifier */
  categoryIdentifier: string;
}

/** = the backend's APNs rule: approval and input are time-sensitive, the rest active. */
export function interruptionLevel(kind: PushKind): InterruptionLevel {
  return kind === 'approval' || kind === 'input' ? 'time-sensitive' : 'active';
}

export function iosPresentation(arrival: PushArrival): IosPresentation {
  return {
    threadIdentifier: arrival.threadId,
    interruptionLevel: interruptionLevel(arrival.kind),
    categoryIdentifier: iosCategoryId(arrival.kind),
  };
}
