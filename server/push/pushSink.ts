// pushSink.ts — where push notifications go (AASC-16).
//
// The AASC backend sends them (it holds the Apple and Google keys); the Mac
// reaches it through the cloud connector. Until a connector registers a sink,
// none is set and the notifier sends nothing.
import type { PushSink } from './pushNotifier.js';

let current: PushSink | null = null;

export function setPushSink(sink: PushSink | null): void {
  current = sink;
}

export function getPushSink(): PushSink | null {
  return current;
}
