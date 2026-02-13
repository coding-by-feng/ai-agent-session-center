import { escapeHtml, sanitizeNumber, debugLog } from './utils.js';

let wsConnected = false;

// Listen for WebSocket connection status events from wsClient
document.addEventListener('ws-status', (e) => {
  wsConnected = e.detail === 'connected';
});

let historicalLoaded = false;
let lastHookStats = null;
let hookStatsVisible = false;

// Close hook stats panel when clicking outside
document.addEventListener('click', () => {
  if (hookStatsVisible) {
    hookStatsVisible = false;
    document.querySelector('.hook-stats-panel')?.classList.add('hidden');
  }
});

export async function loadHistoricalStats() {
  // no-op: historical stats display removed from header
}

export function update(sessions) {
  const el = document.getElementById('global-stats');
  if (!el) return;
  el.innerHTML = '';
  // Re-add hook stats elements
  if (lastHookStats) {
    renderHookStatsBadge(el);
  }
}

export function updateHookStats(stats) {
  lastHookStats = stats;
  const el = document.getElementById('global-stats');
  if (!el) return;
  renderHookStatsBadge(el);
}

function renderHookStatsBadge(container) {
  if (!lastHookStats) return;

  // Remove existing hook stats elements
  container.querySelector('.hook-stats-toggle')?.remove();
  document.querySelector('.hook-stats-panel')?.remove();

  const { totalHooks, hooksPerMin, events } = lastHookStats;

  // Calculate overall avg processing time across all events
  let totalProcessing = 0;
  let processingCount = 0;
  for (const ev of Object.values(events)) {
    if (ev.processing.avg > 0) {
      totalProcessing += ev.processing.avg * ev.count;
      processingCount += ev.count;
    }
  }
  const avgProcessing = processingCount > 0 ? Math.round(totalProcessing / processingCount) : 0;

  // Badge in header
  const badge = document.createElement('span');
  badge.className = 'stat hook-stats-toggle';
  badge.title = 'Click to toggle hook performance details';
  badge.style.cursor = 'pointer';
  badge.innerHTML = `
    <span class="stat-label">Hooks</span>
    <span class="stat-value">${sanitizeNumber(totalHooks)} <span class="hook-rate">(${sanitizeNumber(hooksPerMin)}/min)</span></span>
    <span class="stat-label" style="margin-left:8px">Avg</span>
    <span class="stat-value">${sanitizeNumber(avgProcessing)}ms</span>
  `;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    hookStatsVisible = !hookStatsVisible;
    const panel = document.querySelector('.hook-stats-panel');
    if (panel) panel.classList.toggle('hidden', !hookStatsVisible);
  });
  container.appendChild(badge);

  // Detailed dropdown panel
  const panel = document.createElement('div');
  panel.className = `hook-stats-panel ${hookStatsVisible ? '' : 'hidden'}`;

  // Build table rows sorted by count descending
  const sortedEvents = Object.entries(events).sort((a, b) => b[1].count - a[1].count);
  const rows = sortedEvents.map(([name, ev]) => {
    const latAvg = sanitizeNumber(ev.latency.avg);
    const latP95 = sanitizeNumber(ev.latency.p95);
    const procAvg = sanitizeNumber(ev.processing.avg);
    const procP95 = sanitizeNumber(ev.processing.p95);
    const latStr = latAvg > 0
      ? `${latAvg}ms <span class="hook-stat-dim">(p95: ${latP95}ms)</span>`
      : '<span class="hook-stat-dim">n/a</span>';
    return `<tr>
      <td class="hook-ev-name">${escapeHtml(name)}</td>
      <td class="hook-ev-count">${sanitizeNumber(ev.count)}</td>
      <td class="hook-ev-rate">${sanitizeNumber(ev.rate)}/min</td>
      <td class="hook-ev-latency">${latStr}</td>
      <td class="hook-ev-proc">${procAvg}ms <span class="hook-stat-dim">(p95: ${procP95}ms)</span></td>
    </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="hook-stats-header">
      <span>Hook Performance</span>
      <button class="hook-stats-reset" title="Reset stats">Reset</button>
    </div>
    <table class="hook-stats-table">
      <thead>
        <tr>
          <th>Event</th>
          <th>Count</th>
          <th>Rate</th>
          <th>Delivery Latency</th>
          <th>Server Processing</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  panel.addEventListener('click', (e) => e.stopPropagation());

  panel.querySelector('.hook-stats-reset')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch('/api/hook-stats/reset', { method: 'POST' });
    lastHookStats = null;
    container.querySelector('.hook-stats-toggle')?.remove();
    panel.remove();
    hookStatsVisible = false;
  });

  // Append to body so it escapes all stacking contexts
  document.querySelector('.hook-stats-panel')?.remove();
  document.body.appendChild(panel);
}
