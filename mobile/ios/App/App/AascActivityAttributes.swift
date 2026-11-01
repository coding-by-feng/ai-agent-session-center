// AascActivityAttributes.swift — the Live Activity's ActivityKit type, compiled into the app (which starts, updates
// and ends it: LiveActivityBridge.swift) and the AascLiveActivity extension (which draws it). Everything that changes
// lives in the content state, so switching Macs is an update, not a new activity.
import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct AascActivityAttributes: ActivityAttributes {
    typealias ContentState = LiveActivityCard
}
