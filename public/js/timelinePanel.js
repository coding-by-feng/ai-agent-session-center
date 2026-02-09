import { formatNumber, showTooltip, hideTooltip } from './chartUtils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let initialized = false;

export async function init() {
  if (initialized) return;
  initialized = true;

  // Populate project filter
  const resp = await fetch('/api/projects');
  const { projects } = await resp.json();
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
  const params = new URLSearchParams();
  const granularity = document.getElementById('timeline-granularity').value;
  if (granularity) params.set('granularity', granularity);
  const project = document.getElementById('timeline-project-filter').value;
  if (project) params.set('project', project);
  const dateFrom = document.getElementById('timeline-date-from').value;
  if (dateFrom) params.set('dateFrom', new Date(dateFrom).getTime());
  const dateTo = document.getElementById('timeline-date-to').value;
  if (dateTo) params.set('dateTo', new Date(dateTo + 'T23:59:59').getTime());

  const resp = await fetch(`/api/timeline?${params}`);
  const data = await resp.json();
  const buckets = data.buckets || [];

  const container = document.getElementById('timeline-chart');
  container.innerHTML = '';

  if (buckets.length === 0) {
    container.innerHTML = '<div class="tab-empty">No data for this period</div>';
    return;
  }

  renderTimelineChart(container, buckets, granularity || 'day');
}

function formatTimeLabel(bucket, granularity) {
  const ts = bucket.timestamp || bucket.date || bucket.label;
  if (typeof ts === 'string' && isNaN(Number(ts))) {
    // If already a formatted string label, try to parse it
    const date = new Date(ts);
    if (isNaN(date.getTime())) return ts;
    return formatDateByGranularity(date, granularity);
  }
  const date = new Date(ts);
  if (isNaN(date.getTime())) return String(ts);
  return formatDateByGranularity(date, granularity);
}

function formatDateByGranularity(date, granularity) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  switch (granularity) {
    case 'hour': {
      return date.getHours().toString().padStart(2, '0') + ':00';
    }
    case 'week': {
      const oneJan = new Date(date.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((date - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
      return 'W' + weekNum.toString().padStart(2, '0');
    }
    default: {
      return months[date.getMonth()] + ' ' + date.getDate();
    }
  }
}

function renderTimelineChart(container, buckets, granularity) {
  const svgWidth = container.clientWidth || 700;
  const svgHeight = 300;
  const paddingLeft = 50;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = 50;
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
    const labelStep = Math.max(1, Math.floor(groupCount / 15));
    if (i % labelStep === 0 || i === groupCount - 1) {
      const label = bucket.label || formatTimeLabel(bucket, granularity);
      const text = createEl('text', {
        x: groupX + groupWidth / 2,
        y: svgHeight - 28,
        fill: '#8892b0',
        'font-size': '9',
        'text-anchor': 'middle',
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
