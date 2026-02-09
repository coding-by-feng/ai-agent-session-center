const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Draw a bar chart as SVG inside the given container.
 * data = [{label, value, color?}]
 */
export function drawBarChart(container, data, options = {}) {
  const {
    horizontal = true,
    maxBars = 15,
    barHeight = 20,
    gap = 4,
    showLabels = true,
    showValues = true,
  } = options;

  container.innerHTML = '';
  const items = data.slice(0, maxBars);
  if (items.length === 0) return;

  const maxVal = Math.max(...items.map(d => d.value), 1);
  const labelWidth = showLabels ? 100 : 0;
  const valueWidth = showValues ? 50 : 0;

  if (horizontal) {
    const totalHeight = items.length * (barHeight + gap) - gap;
    const svgWidth = container.clientWidth || 400;
    const barAreaWidth = svgWidth - labelWidth - valueWidth - 10;

    const svg = createSvg(svgWidth, totalHeight);

    items.forEach((d, i) => {
      const y = i * (barHeight + gap);
      const barW = Math.max(1, (d.value / maxVal) * barAreaWidth);
      const color = d.color || 'var(--accent-cyan, #00e5ff)';

      if (showLabels) {
        const text = createSvgEl('text', {
          x: labelWidth - 6,
          y: y + barHeight / 2 + 4,
          fill: '#8892b0',
          'font-size': '11',
          'text-anchor': 'end',
        });
        text.textContent = d.label;
        svg.appendChild(text);
      }

      const rect = createSvgEl('rect', {
        x: labelWidth,
        y,
        width: barW,
        height: barHeight,
        rx: 3,
        fill: color,
        opacity: 0.85,
      });
      svg.appendChild(rect);

      if (showValues) {
        const valText = createSvgEl('text', {
          x: labelWidth + barW + 6,
          y: y + barHeight / 2 + 4,
          fill: '#ccd6f6',
          'font-size': '11',
        });
        valText.textContent = formatNumber(d.value);
        svg.appendChild(valText);
      }
    });

    container.appendChild(svg);
  } else {
    // Vertical bars
    const svgHeight = 200;
    const svgWidth = container.clientWidth || 400;
    const barWidth = Math.max(4, (svgWidth - 40) / items.length - gap);
    const chartHeight = svgHeight - 30;

    const svg = createSvg(svgWidth, svgHeight);

    items.forEach((d, i) => {
      const x = 20 + i * (barWidth + gap);
      const barH = Math.max(1, (d.value / maxVal) * chartHeight);
      const y = chartHeight - barH;
      const color = d.color || 'var(--accent-cyan, #00e5ff)';

      const rect = createSvgEl('rect', {
        x,
        y,
        width: barWidth,
        height: barH,
        rx: 2,
        fill: color,
        opacity: 0.85,
      });
      svg.appendChild(rect);

      if (showLabels) {
        const text = createSvgEl('text', {
          x: x + barWidth / 2,
          y: svgHeight - 4,
          fill: '#8892b0',
          'font-size': '9',
          'text-anchor': 'middle',
        });
        text.textContent = d.label;
        svg.appendChild(text);
      }

      if (showValues) {
        const valText = createSvgEl('text', {
          x: x + barWidth / 2,
          y: y - 4,
          fill: '#ccd6f6',
          'font-size': '9',
          'text-anchor': 'middle',
        });
        valText.textContent = formatNumber(d.value);
        svg.appendChild(valText);
      }
    });

    container.appendChild(svg);
  }
}

/**
 * Draw a line chart as SVG inside the given container.
 * data = [{label, value}]
 */
export function drawLineChart(container, data, options = {}) {
  const {
    color = '#00e5ff',
    areaFill = false,
    showDots = true,
    height = 250,
  } = options;

  container.innerHTML = '';
  if (data.length === 0) return;

  const svgWidth = container.clientWidth || 500;
  const paddingLeft = 45;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = 30;
  const chartW = svgWidth - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const maxVal = Math.max(...data.map(d => d.value), 1);
  const svg = createSvg(svgWidth, height);

  // Y-axis labels (5 ticks)
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i;
    const y = paddingTop + chartH - (i / 4) * chartH;
    const text = createSvgEl('text', {
      x: paddingLeft - 6,
      y: y + 4,
      fill: '#8892b0',
      'font-size': '10',
      'text-anchor': 'end',
    });
    text.textContent = formatNumber(val);
    svg.appendChild(text);

    // Grid line
    const line = createSvgEl('line', {
      x1: paddingLeft,
      y1: y,
      x2: svgWidth - paddingRight,
      y2: y,
      stroke: '#1e2a4a',
      'stroke-width': 1,
    });
    svg.appendChild(line);
  }

  // Build points
  const points = data.map((d, i) => {
    const x = paddingLeft + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = paddingTop + chartH - (d.value / maxVal) * chartH;
    return { x, y, label: d.label, value: d.value };
  });

  // Area fill
  if (areaFill && points.length > 1) {
    const areaPoints = [
      `${points[0].x},${paddingTop + chartH}`,
      ...points.map(p => `${p.x},${p.y}`),
      `${points[points.length - 1].x},${paddingTop + chartH}`,
    ].join(' ');
    const polygon = createSvgEl('polygon', {
      points: areaPoints,
      fill: color,
      opacity: 0.1,
    });
    svg.appendChild(polygon);
  }

  // Line
  if (points.length > 1) {
    const polyline = createSvgEl('polyline', {
      points: points.map(p => `${p.x},${p.y}`).join(' '),
      fill: 'none',
      stroke: color,
      'stroke-width': 2,
      'stroke-linejoin': 'round',
    });
    svg.appendChild(polyline);
  }

  // Dots
  if (showDots) {
    points.forEach(p => {
      const circle = createSvgEl('circle', {
        cx: p.x,
        cy: p.y,
        r: 3,
        fill: color,
      });
      circle.addEventListener('mouseenter', (e) => showTooltip(`${p.label}: ${formatNumber(p.value)}`, e.pageX, e.pageY));
      circle.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(circle);
    });
  }

  // X-axis labels (show up to ~10 evenly spaced)
  const labelStep = Math.max(1, Math.floor(data.length / 10));
  points.forEach((p, i) => {
    if (i % labelStep !== 0 && i !== points.length - 1) return;
    const text = createSvgEl('text', {
      x: p.x,
      y: height - 6,
      fill: '#8892b0',
      'font-size': '9',
      'text-anchor': 'middle',
    });
    text.textContent = p.label;
    svg.appendChild(text);
  });

  container.appendChild(svg);
}

/**
 * Draw a heatmap grid using CSS grid.
 * data = [{row, col, value}] where row=0-6 (Mon-Sun), col=0-23 (hours)
 */
export function drawHeatmapGrid(container, data, options = {}) {
  const {
    cellSize = 14,
    gap = 2,
    colorMin = '#12122a',
    colorMax = '#00ff88',
  } = options;

  container.innerHTML = '';

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const maxVal = Math.max(...data.map(d => d.value), 1);

  // Build value lookup
  const valueMap = new Map();
  data.forEach(d => valueMap.set(`${d.row}-${d.col}`, d.value));

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `40px repeat(24, ${cellSize}px)`;
  grid.style.gridTemplateRows = `${cellSize}px repeat(7, ${cellSize}px)`;
  grid.style.gap = `${gap}px`;
  grid.style.alignItems = 'center';

  // Top-left empty corner
  const corner = document.createElement('div');
  grid.appendChild(corner);

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
    dayLbl.textContent = dayLabels[r];
    dayLbl.style.fontSize = '10px';
    dayLbl.style.color = '#8892b0';
    dayLbl.style.textAlign = 'right';
    dayLbl.style.paddingRight = '4px';
    grid.appendChild(dayLbl);

    for (let c = 0; c < 24; c++) {
      const val = valueMap.get(`${r}-${c}`) || 0;
      const cell = document.createElement('div');
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;
      cell.style.borderRadius = '2px';
      cell.style.backgroundColor = interpolateColor(val, 0, maxVal, colorMin, colorMax);
      cell.style.cursor = 'pointer';
      cell.addEventListener('mouseenter', (e) => showTooltip(`${dayLabels[r]} ${c}:00 - ${val}`, e.pageX, e.pageY));
      cell.addEventListener('mouseleave', hideTooltip);
      grid.appendChild(cell);
    }
  }

  container.appendChild(grid);
}

/**
 * Format a number for display: 0->"0", 999->"999", 1000->"1.0k", 1500->"1.5k", 1000000->"1.0M"
 */
export function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

/**
 * Show a tooltip div at the given page coordinates.
 */
export function showTooltip(text, x, y) {
  let tip = document.querySelector('.chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.left = `${x + 10}px`;
  tip.style.top = `${y - 28}px`;
  tip.style.display = 'block';
}

/**
 * Hide the tooltip.
 */
export function hideTooltip() {
  const tip = document.querySelector('.chart-tooltip');
  if (tip) tip.style.display = 'none';
}

/**
 * Interpolate a hex color between colorStart and colorEnd based on value's position in [min, max].
 */
export function interpolateColor(value, min, max, colorStart = '#12122a', colorEnd = '#00ff88') {
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
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// -- Internal helpers --

function createSvg(width, height) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return svg;
}

function createSvgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}
