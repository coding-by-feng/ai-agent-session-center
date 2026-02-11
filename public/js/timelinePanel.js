import { formatNumber, showTooltip, hideTooltip } from './chartUtils.js';
import { getDistinctProjects, getTimeline } from './browserDb.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let initialized = false;

export async function init() {
  if (initialized) return;
  initialized = true;

  // Populate project filter from IndexedDB
  const projects = await getDistinctProjects();
  const select = document.getElementById('timeline-project-filter');
  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.project_path;
    opt.textContent = p.project_name;
    select.appendChild(opt);
  });

  // Set default date range (last 30 days)
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  document.getElementById('timeline-date-from').value = thirtyDaysAgo.toISOString().split('T')[0];
  document.getElementById('timeline-date-to').value = now.toISOString().split('T')[0];

  // Wire controls
  ['timeline-granularity', 'timeline-project-filter', 'timeline-date-from', 'timeline-date-to'].forEach(id => {
    document.getElementById(id).addEventListener('change', loadTimeline);
  });

  await loadTimeline();
}

export async function refresh() {
  await init();
  await loadTimeline();
}

async function loadTimeline() {
  const granularity = document.getElementById('timeline-granularity').value || 'day';
  const project = document.getElementById('timeline-project-filter').value;
  const dateFrom = document.getElementById('timeline-date-from').value;
  const dateTo = document.getElementById('timeline-date-to').value;

  const data = await getTimeline({
    granularity,
    project: project || undefined,
    dateFrom: dateFrom ? new Date(dateFrom).getTime() : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59').getTime() : undefined,
  });
  const buckets = data.buckets || [];

  const container = document.getElementById('timeline-chart');
  container.innerHTML = '';

  if (buckets.length === 0) {
    container.innerHTML = '<div class="tab-empty">No data for this period</div>';
    return;
  }

  renderTimelineChart(container, buckets, granularity);
}

function formatTimeLabel(bucket, granularity) {
  const ts = bucket.period || bucket.timestamp || bucket.date || bucket.label;
  if (!ts) return '';

  // Week format: "2026-W06"
  if (granularity === 'week') {
    const weekMatch = String(ts).match(/^(\d{4})-W(\d{1,2})$/);
    if (weekMatch) {
      const year = parseInt(weekMatch[1], 10);
      const week = parseInt(weekMatch[2], 10);
      const jan1 = new Date(year, 0, 1);
      const dayOffset = (week - 1) * 7 - jan1.getDay() + 1;
      const weekStart = new Date(year, 0, 1 + dayOffset);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[weekStart.getMonth()] + ' ' + weekStart.getDate();
    }
  }

  // Hour format: "2026-02-10 14:00"
  if (granularity === 'hour' && typeof ts === 'string') {
    const hourMatch = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
    if (hourMatch) {
      const date = new Date(hourMatch[1] + 'T' + hourMatch[2] + ':' + hourMatch[3] + ':00');
      if (!isNaN(date.getTime())) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return months[date.getMonth()] + ' ' + date.getDate() + ' ' + date.getHours().toString().padStart(2, '0') + ':00';
      }
    }
  }

  // Day format: "2026-02-10"
  if (typeof ts === 'string') {
    const date = new Date(ts + (ts.includes('T') ? '' : 'T00:00:00'));
    if (!isNaN(date.getTime())) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[date.getMonth()] + ' ' + date.getDate();
    }
    return ts;
  }

  // Numeric timestamp
  const date = new Date(ts);
  if (!isNaN(date.getTime())) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[date.getMonth()] + ' ' + date.getDate();
  }
  return String(ts);
}

function renderTimelineChart(container, buckets, granularity) {
  const svgWidth = container.clientWidth || 700;
  const paddingLeft = 50;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = granularity === 'hour' ? 70 : 50;
  const svgHeight = 300 + (granularity === 'hour' ? 20 : 0);
  const chartW = svgWidth - paddingLeft - paddingRight;
  const chartH = svgHeight - paddingTop - paddingBottom;

  // Max across all individual bar values (grouped, not stacked)
  const maxVal = Math.max(
    ...buckets.map(b => Math.max(
      b.session_count || 0,
      b.prompt_count || 0,
      b.tool_call_count || 0
    )),
    1
  );

  const svg = createEl('svg', {
    width: '100%',
    height: svgHeight,
    viewBox: `0 0 ${svgWidth} ${svgHeight}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  // Y-axis grid lines and labels (5 ticks)
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i;
    const y = paddingTop + chartH - (i / 4) * chartH;

    const text = createEl('text', {
      x: paddingLeft - 8,
      y: y + 4,
      fill: '#8892b0',
      'font-size': '10',
      'text-anchor': 'end',
    });
    text.textContent = formatNumber(val);
    svg.appendChild(text);

    const line = createEl('line', {
      x1: paddingLeft,
      y1: y,
      x2: svgWidth - paddingRight,
      y2: y,
      stroke: '#1e2a4a',
      'stroke-width': 1,
    });
    svg.appendChild(line);
  }

  // Grouped bars: 3 bars per bucket
  const groupCount = buckets.length;
  const groupWidth = chartW / groupCount;
  const barGap = 1;
  const barWidth = Math.max(2, (groupWidth - 4 * barGap) / 3);

  const colors = {
    session: '#00e5ff',
    prompt: '#00ff88',
    tool: '#ff9800',
  };

  buckets.forEach((bucket, i) => {
    const groupX = paddingLeft + i * groupWidth;
    const sessions = bucket.session_count || 0;
    const prompts = bucket.prompt_count || 0;
    const tools = bucket.tool_call_count || 0;

    const bars = [
      { value: sessions, color: colors.session, label: 'Sessions' },
      { value: prompts, color: colors.prompt, label: 'Prompts' },
      { value: tools, color: colors.tool, label: 'Tool Calls' },
    ];

    const barsStartX = groupX + (groupWidth - 3 * barWidth - 2 * barGap) / 2;

    bars.forEach((bar, j) => {
      const barH = Math.max(0, (bar.value / maxVal) * chartH);
      const x = barsStartX + j * (barWidth + barGap);
      const y = paddingTop + chartH - barH;

      if (barH > 0) {
        const rect = createEl('rect', {
          x, y,
          width: barWidth,
          height: barH,
          rx: 2,
          fill: bar.color,
          opacity: 0.85,
        });
        rect.addEventListener('mouseenter', (e) => {
          rect.setAttribute('opacity', '1');
          showTooltip(
            `${bar.label}: ${bar.value}\nSessions: ${sessions} | Prompts: ${prompts} | Tools: ${tools}`,
            e.pageX, e.pageY
          );
        });
        rect.addEventListener('mouseleave', () => {
          rect.setAttribute('opacity', '0.85');
          hideTooltip();
        });
        svg.appendChild(rect);
      }
    });

    // X-axis label (show subset to avoid overlap)
    const maxLabels = granularity === 'hour' ? 12 : granularity === 'week' ? 12 : 15;
    const labelStep = Math.max(1, Math.ceil(groupCount / maxLabels));
    if (i % labelStep === 0 || i === groupCount - 1) {
      const label = formatTimeLabel(bucket, granularity);
      const lx = groupX + groupWidth / 2;
      const ly = paddingTop + chartH + 14;
      // Rotate labels when there are many buckets to prevent overlap
      const shouldRotate = groupCount > 10 || granularity === 'hour';
      const text = createEl('text', {
        x: lx,
        y: ly,
        fill: '#8892b0',
        'font-size': '9',
        'text-anchor': shouldRotate ? 'end' : 'middle',
        ...(shouldRotate ? { transform: `rotate(-40 ${lx} ${ly})` } : {}),
      });
      text.textContent = label;
      svg.appendChild(text);
    }
  });

  // Legend
  const legendY = svgHeight - 12;
  const legendItems = [
    { label: 'Sessions', color: colors.session },
    { label: 'Prompts', color: colors.prompt },
    { label: 'Tool Calls', color: colors.tool },
  ];
  legendItems.forEach((item, i) => {
    const lx = paddingLeft + i * 100;
    const rect = createEl('rect', {
      x: lx, y: legendY - 8,
      width: 8, height: 8,
      rx: 1, fill: item.color,
      opacity: 0.85,
    });
    svg.appendChild(rect);
    const text = createEl('text', {
      x: lx + 12, y: legendY,
      fill: '#8892b0', 'font-size': '9',
    });
    text.textContent = item.label;
    svg.appendChild(text);
  });

  container.appendChild(svg);
}

function createEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}
