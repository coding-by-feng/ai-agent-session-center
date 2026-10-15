// AascWidgetProvider.kt — the home-screen widget: "N sessions need you" (AASC-21 M6).
//
// Draws only what the shell's widgetModel.ts wrote to the `aasc_widget` prefs (ShellBridge.writeWidget):
// the headline, the most urgent session's title and label, and when it was updated. No logic,
// no network: it refreshes when the app writes a new model. Tapping it opens the app.
package work.aasc.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import java.util.Date

class AascWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
    }

    companion object {
        fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val json = context.getSharedPreferences(WidgetRules.PREFS, Context.MODE_PRIVATE).getString(WidgetRules.KEY, null)
            val view = WidgetRules.parse(json)
            val open = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val views = RemoteViews(context.packageName, R.layout.widget_aasc).apply {
                setTextViewText(R.id.widget_headline, view?.headline ?: context.getString(R.string.widget_empty))
                setTextViewText(R.id.widget_top, listOfNotNull(view?.title, view?.label).joinToString(" · "))
                setViewVisibility(R.id.widget_top, if (view?.title != null || view?.label != null) View.VISIBLE else View.GONE)
                val updated = view?.updatedAt?.takeIf { it > 0 }?.let { DateFormat.getTimeFormat(context).format(Date(it)) }
                setTextViewText(R.id.widget_updated, updated?.let { context.getString(R.string.widget_updated, it) } ?: "")
                setOnClickPendingIntent(R.id.widget_root, open)
            }
            manager.updateAppWidget(ids, views)
        }
    }
}
