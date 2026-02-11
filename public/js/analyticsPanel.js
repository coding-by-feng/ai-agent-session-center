import { drawBarChart, drawLineChart, drawHeatmapGrid, formatNumber, showTooltip, hideTooltip } from './chartUtils.js';
import * as db from './browserDb.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let initialized = false;

export async function init() {
  if (initialized) return;
  initialized = true;
  await loadAll();
}

export async function refresh() {
  await init();
  await loadAll();
}

async function loadAll() {
  const [summary, tools, trends, projects, heatmap] = await Promise.all([
    db.getSummaryStats(),
    db.getToolBreakdown(),
    db.getDurationTrends({ period: 'day' }),
    db.getActiveProjects(),
    db.getHeatmap(),
  ]);

  renderSummary(summary);
  renderToolUsage(tools);
  renderDurationTrends(trends);
  renderActiveProjects(projects);
  renderHeatmap(heatmap);
}

// -- 1. Summary Stats --

function renderSummary(data) {
  const container = document.getElementById('analytics-summary');
  container.innerHTML = '';

  const mostTool = data.most_used_tool;
  const busiestProj = data.busiest_project;

  const stats = [
    { label: 'Total Sessions', value: formatNumber(data.total_sessions || 0), detail: 'all time' },
    { label: 'Total Prompts', value: formatNumber(data.total_prompts || 0), detail: 'all time' },
    { label: 'Total Tool Calls', value: formatNumber(data.total_tool_calls || 0), detail: 'all time' },
    { label: 'Avg Duration', value: formatDuration(data.avg_duration || data.avg_session_duration_ms || 0), detail: 'per session' },
    {
      label: 'Most Used Tool',
      value: mostTool ? (mostTool.tool_name || mostTool.name) : 'N/A',
      detail: mostTool ? formatNumber(mostTool.count) + ' calls' : '',
    },
    {
      label: 'Busiest Project',
      value: busiestProj ? (busiestProj.project_path || busiestProj.name) : 'N/A',
      detail: busiestProj ? formatNumber(busiestProj.count || busiestProj.sessions) + ' sessions' : '',
    },
  ];

  stats.forEach(s => {
    const card = document.createElement('div');
    card.className = 'summary-stat';
    card.innerHTML =
      '<span class="stat-label">' + escapeHtml(s.label) + '</span>' +
      '<span class="stat-value">' + escapeHtml(s.value) + '</span>' +
      '<span class="stat-detail">' + escapeHtml(s.detail) + '</span>';
    container.appendChild(card);
  });
}

// -- 2. Tool Usage Breakdown --

function renderToolUsage(data) {
  const container = document.getElementById('tool-usage-chart');
  container.innerHTML = '';

  const heading = document.createElement('h4');
  heading.textContent = 'TOOL USAGE';
  container.appendChild(heading);

  const tools = (Array.isArray(data) ? data : data.tools || []).slice(0, 15);
  if (tools.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div class="tab-empty">No tool data</div>');
    return;
  }

  const totalCalls = tools.reduce((sum, t) => sum + (t.count || 0), 0) || 1;

  const chartDiv = document.createElement('div');
  container.appendChild(chartDiv);

  const barHeight = 20;
  const gap = 4;
  const labelWidth = 120;
  const valueWidth = 90;
  const totalHeight = tools.length * (barHeight + gap) - gap;
  const svgWidth = chartDiv.clientWidth || container.clientWidth || 500;
  const barAreaWidth = Math.max(50, svgWidth - labelWidth - valueWidth - 10);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', totalHeight);
  svg.setAttribute('viewBox', '0 0 ' + svgWidth + ' ' + totalHeight);

  const maxVal = Math.max(...tools.map(t => t.count || 0), 1);

  tools.forEach((t, i) => {
    const y = i * (barHeight + gap);
    const count = t.count || 0;
    const barW = Math.max(1, (count / maxVal) * barAreaWidth);
    const pct = ((count / totalCalls) * 100).toFixed(1);
    const name = t.tool_name || t.name || '';

    // Label
    const text = createSvgText(labelWidth - 6, y + barHeight / 2 + 4, name, {
      fill: '#8892b0', 'font-size': '11', 'text-anchor': 'end',
    });
    svg.appendChild(text);

    // Bar
    const rect = document.createElementNS(SVG_NS, 'rect');
    setAttrs(rect, {
      x: labelWidth, y: y,
      width: barW, height: barHeight,
      rx: 3, fill: '#00e5ff', opacity: 0.85,
    });
    rect.addEventListener('mouseenter', (e) => {
      rect.setAttribute('opacity', '1');
      showTooltip(name + ': ' + formatNumber(count) + ' (' + pct + '%)', e.pageX, e.pageY);
    });
    rect.addEventListener('mouseleave', () => {
      rect.setAttribute('opacity', '0.85');
      hideTooltip();
    });
    svg.appendChild(rect);

    // Value + percentage
    const valText = createSvgText(labelWidth + barW + 6, y + barHeight / 2 + 4,
      formatNumber(count) + ' (' + pct + '%)', {
        fill: '#ccd6f6', 'font-size': '11',
      });
    svg.appendChild(valText);
  });

  chartDiv.appendChild(svg);
}

// -- 3. Duration Trends --

function renderDurationTrends(data) {
  const container = document.getElementById('duration-trends-chart');
  container.innerHTML = '';

  const heading = document.createElement('h4');
  heading.textContent = 'SESSION DURATION TRENDS';
  container.appendChild(heading);

  const points = Array.isArray(data) ? data : (data.buckets || data.trends || []);
  if (points.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div class="tab-empty">No duration data</div>');
    return;
  }

  const chartDiv = document.createElement('div');
  container.appendChild(chartDiv);

  const svgWidth = chartDiv.clientWidth || container.clientWidth || 500;
  const height = 250;
  const paddingLeft = 55;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = 30;
  const chartW = svgWidth - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const lineData = points.map(p => {
    const raw = p.period || p.timestamp || p.date || p.label;
    let label = String(raw);
    // Try to parse date strings like "2024-01-15" into "Jan 15"
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const date = new Date(raw + 'T00:00:00');
      if (!isNaN(date.getTime())) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        label = months[date.getMonth()] + ' ' + date.getDate();
      }
    }
    return { label, value: p.avg_duration || p.avg_duration_ms || 0 };
  });

  const maxVal = Math.max(...lineData.map(d => d.value), 1);
  const color = '#00e5ff';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', '0 0 ' + svgWidth + ' ' + height);

  // Y-axis with duration formatting
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i;
    const y = paddingTop + chartH - (i / 4) * chartH;

    const text = createSvgText(paddingLeft - 6, y + 4, formatDuration(val), {
      fill: '#8892b0', 'font-size': '10', 'text-anchor': 'end',
    });
    svg.appendChild(text);

    const line = document.createElementNS(SVG_NS, 'line');
    setAttrs(line, {
      x1: paddingLeft, y1: y,
      x2: svgWidth - paddingRight, y2: y,
      stroke: '#1e2a4a', 'stroke-width': 1,
    });
    svg.appendChild(line);
  }

  // Build coordinate points
  const pts = lineData.map((d, i) => {
    const x = paddingLeft + (i / Math.max(lineData.length - 1, 1)) * chartW;
    const y = paddingTop + chartH - (d.value / maxVal) * chartH;
    return { x: x, y: y, label: d.label, value: d.value };
  });

  // Area fill
  if (pts.length > 1) {
    const areaPoints = [
      pts[0].x + ',' + (paddingTop + chartH),
      ...pts.map(p => p.x + ',' + p.y),
      pts[pts.length - 1].x + ',' + (paddingTop + chartH),
    ].join(' ');
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    setAttrs(polygon, { points: areaPoints, fill: color, opacity: 0.1 });
    svg.appendChild(polygon);
  }

  // Line
  if (pts.length > 1) {
    const polyline = document.createElementNS(SVG_NS, 'polyline');
    setAttrs(polyline, {
      points: pts.map(p => p.x + ',' + p.y).join(' '),
      fill: 'none', stroke: color,
      'stroke-width': 2, 'stroke-linejoin': 'round',
    });
    svg.appendChild(polyline);
  }

  // Dots with duration tooltip
  pts.forEach(p => {
    const circle = document.createElementNS(SVG_NS, 'circle');
    setAttrs(circle, { cx: p.x, cy: p.y, r: 3, fill: color });
    circle.addEventListener('mouseenter', (e) => showTooltip(p.label + ': ' + formatDuration(p.value), e.pageX, e.pageY));
    circle.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(circle);
  });

  // X-axis labels
  const labelStep = Math.max(1, Math.floor(lineData.length / 10));
  pts.forEach((p, i) => {
    if (i % labelStep !== 0 && i !== pts.length - 1) return;
    const text = createSvgText(p.x, height - 6, p.label, {
      fill: '#8892b0', 'font-size': '9', 'text-anchor': 'middle',
    });
    svg.appendChild(text);
  });

  chartDiv.appendChild(svg);
}

// -- 4. Active Projects --

function renderActiveProjects(data) {
  const container = document.getElementById('active-projects-chart');
  container.innerHTML = '';

  const heading = document.createElement('h4');
  heading.textContent = 'PROJECTS BY ACTIVITY';
  container.appendChild(heading);

  const projects = (Array.isArray(data) ? data : data.projects || [])
    .sort((a, b) => (b.session_count || 0) - (a.session_count || 0));

  if (projects.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div class="tab-empty">No project data</div>');
    return;
  }

  const chartDiv = document.createElement('div');
  container.appendChild(chartDiv);

  const barHeight = 22;
  const gap = 4;
  const labelWidth = 130;
  const valueWidth = 160;
  const totalHeight = projects.length * (barHeight + gap) - gap;
  const svgWidth = chartDiv.clientWidth || container.clientWidth || 500;
  const barAreaWidth = Math.max(50, svgWidth - labelWidth - valueWidth - 10);
  const maxVal = Math.max(...projects.map(p => p.session_count || 0), 1);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', totalHeight);
  svg.setAttribute('viewBox', '0 0 ' + svgWidth + ' ' + totalHeight);

  projects.forEach((p, i) => {
    const y = i * (barHeight + gap);
    const count = p.session_count || 0;
    const barW = Math.max(1, (count / maxVal) * barAreaWidth);
    const name = p.project_name || p.name || p.project_path || '';
    const lastActive = (p.last_activity || p.last_active_at) ? formatDate(p.last_activity || p.last_active_at) : '';

    // Project name
    const text = createSvgText(labelWidth - 6, y + barHeight / 2 + 4, name, {
      fill: '#8892b0', 'font-size': '11', 'text-anchor': 'end',
    });
    svg.appendChild(text);

    // Bar
    const rect = document.createElementNS(SVG_NS, 'rect');
    setAttrs(rect, {
      x: labelWidth, y: y,
      width: barW, height: barHeight,
      rx: 3, fill: '#00e5ff', opacity: 0.85,
    });
    rect.addEventListener('mouseenter', (e) => {
      rect.setAttribute('opacity', '1');
      showTooltip(name + ': ' + formatNumber(count) + ' sessions, ' + formatNumber(p.total_prompts || 0) + ' prompts, ' + formatNumber(p.total_tools || 0) + ' tools', e.pageX, e.pageY);
    });
    rect.addEventListener('mouseleave', () => {
      rect.setAttribute('opacity', '0.85');
      hideTooltip();
    });
    svg.appendChild(rect);

    // Session count and last active
    const detail = formatNumber(count) + ' sessions' + (lastActive ? ' | ' + lastActive : '');
    const valText = createSvgText(labelWidth + barW + 6, y + barHeight / 2 + 4, detail, {
      fill: '#ccd6f6', 'font-size': '11',
    });
    svg.appendChild(valText);
  });

  chartDiv.appendChild(svg);
}

// -- 5. Daily Heatmap --

function renderHeatmap(data) {
  const container = document.getElementById('daily-heatmap-chart');
  container.innerHTML = '';

  const heading = document.createElement('h4');
  heading.textContent = 'ACTIVITY HEATMAP';
  container.appendChild(heading);

  const rawData = Array.isArray(data) ? data : (data.cells || data.heatmap || []);
  if (rawData.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div class="tab-empty">No heatmap data</div>');
    return;
  }

  const dayLabelsFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayLabelsShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const gridData = rawData.map(d => ({
    row: d.day_of_week != null ? d.day_of_week : (d.day != null ? d.day : d.row),
    col: d.hour != null ? d.hour : d.col,
    value: d.count || d.value || 0,
  }));

  const cellSize = 14;
  const gapSize = 2;
  const colorMin = '#12122a';
  const colorMax = '#00ff88';

  const maxVal = Math.max(...gridData.map(d => d.value), 1);
  const valueMap = new Map();
  gridData.forEach(d => valueMap.set(d.row + '-' + d.col, d.value));

  const chartDiv = document.createElement('div');
  container.appendChild(chartDiv);

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '40px repeat(24, ' + cellSize + 'px)';
  grid.style.gridTemplateRows = cellSize + 'px repeat(7, ' + cellSize + 'px)';
  grid.style.gap = gapSize + 'px';
  grid.style.alignItems = 'center';

  // Top-left empty corner
  grid.appendChild(document.createElement('div'));

  // Hour labels (top row)
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.textContent = h;
    lbl.style.fontSize = '9px';
    lbl.style.color = '#8892b0';
    lbl.style.textAlign = 'center';
    grid.appendChild(lbl);
  }

  // Rows
  for (let r = 0; r < 7; r++) {
    // Day label
    const dayLbl = document.createElement('div');
    dayLbl.textContent = dayLabelsShort[r];
    dayLbl.style.fontSize = '10px';
    dayLbl.style.color = '#8892b0';
    dayLbl.style.textAlign = 'right';
    dayLbl.style.paddingRight = '4px';
    grid.appendChild(dayLbl);

    for (let c = 0; c < 24; c++) {
      const val = valueMap.get(r + '-' + c) || 0;
      const cell = document.createElement('div');
      cell.style.width = cellSize + 'px';
      cell.style.height = cellSize + 'px';
      cell.style.borderRadius = '2px';
      cell.style.backgroundColor = interpolateColor(val, 0, maxVal, colorMin, colorMax);
      cell.style.cursor = 'pointer';
      const tipText = dayLabelsFull[r] + ' ' + c.toString().padStart(2, '0') + ':00 - ' + val + ' events';
      cell.addEventListener('mouseenter', (e) => showTooltip(tipText, e.pageX, e.pageY));
      cell.addEventListener('mouseleave', hideTooltip);
      grid.appendChild(cell);
    }
  }

  chartDiv.appendChild(grid);
}

// -- Helpers --

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function formatDate(ts) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function interpolateColor(value, min, max, colorStart, colorEnd) {
  const t = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r1 = parseInt(colorStart.slice(1, 3), 16);
  const g1 = parseInt(colorStart.slice(3, 5), 16);
  const b1 = parseInt(colorStart.slice(5, 7), 16);
  const r2 = parseInt(colorEnd.slice(1, 3), 16);
  const g2 = parseInt(colorEnd.slice(3, 5), 16);
  const b2 = parseInt(colorEnd.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function createSvgText(x, y, content, attrs) {
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  for (const [k, v] of Object.entries(attrs)) {
    text.setAttribute(k, String(v));
  }
  text.textContent = content;
  return text;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
}
