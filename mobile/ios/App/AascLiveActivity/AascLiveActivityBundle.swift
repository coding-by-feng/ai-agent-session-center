// AascLiveActivityBundle.swift — the widget extension's entry point: only the Live Activity
// (AascLiveActivityWidget.swift), no home-screen widget yet.
import SwiftUI
import WidgetKit

@main
struct AascLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        AascLiveActivityWidget()
    }
}
