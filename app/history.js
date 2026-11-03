// Storage trend chart and change list for the optional scan history.
// Pure rendering: app.js supplies the data, translations and formatters.

const HEIGHT = 168;
const PAD = { top: 14, right: 16, bottom: 26, left: 62 };

function niceStep(range) {
  const rough = range / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= rough);
}

// Y ticks in GiB, rounded to clean numbers.
function yScale(values) {
  const gib = 1024 ** 3;
  let low = Math.min(...values) / gib;
  let high = Math.max(...values) / gib;
  if (high - low < 1) { low -= 1; high += 1; }
  const step = niceStep(high - low);
  low = Math.max(0, Math.floor(low / step) * step);
  high = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = low; value <= high + step / 2; value += step) ticks.push(value);
  return { low: low * gib, high: high * gib, ticks: ticks.map((value) => value * gib), decimals: step < 1 ? 1 : 0 };
}

export function changes(entries) {
  if (entries.length < 2) return null;
  const previous = entries.at(-2);
  const latest = entries.at(-1);
  const before = new Map(previous.apps.map(([appid, name, size]) => [appid, { name, size }]));
  const after = new Map(latest.apps.map(([appid, name, size]) => [appid, { name, size }]));
  const rows = [];
  for (const appid of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(appid);
    const now = after.get(appid);
    const delta = (now?.size || 0) - (old?.size || 0);
    if (delta !== 0) rows.push({ appid, name: (now || old).name, delta, kind: !old ? 'added' : !now ? 'removed' : 'changed' });
  }
  rows.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  return { previous, latest, delta: latest.installed - previous.installed, rows: rows.slice(0, 6), more: Math.max(0, rows.length - 6) };
}

// Drawn at the container's real width so text keeps its size on narrow windows.
export function chartMarkup(entries, { formatGib, formatDate, label }, WIDTH) {
  const values = entries.map((entry) => entry.installed);
  const { low, high, ticks, decimals } = yScale(values);
  const first = entries[0].scannedAt;
  const last = entries.at(-1).scannedAt;
  const x = (time) => PAD.left + (last === first ? (WIDTH - PAD.left - PAD.right) / 2 : ((time - first) / (last - first)) * (WIDTH - PAD.left - PAD.right));
  const y = (value) => PAD.top + (1 - (value - low) / (high - low || 1)) * (HEIGHT - PAD.top - PAD.bottom);
  const points = entries.map((entry) => [x(entry.scannedAt), y(entry.installed)]);
  const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const baseline = HEIGHT - PAD.bottom;
  const area = `${line}L${points.at(-1)[0].toFixed(1)},${baseline}L${points[0][0].toFixed(1)},${baseline}Z`;
  const grid = ticks.map((tick) => `<line class="chart-grid" x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"/><text class="chart-axis" x="${PAD.left - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${formatGib(tick, decimals)}</text>`).join('');
  const xLabels = entries.length > 1
    ? `<text class="chart-axis" x="${PAD.left}" y="${HEIGHT - 6}">${formatDate(first)}</text><text class="chart-axis" x="${WIDTH - PAD.right}" y="${HEIGHT - 6}" text-anchor="end">${formatDate(last)}</text>`
    : `<text class="chart-axis" x="${points[0][0]}" y="${HEIGHT - 6}" text-anchor="middle">${formatDate(first)}</text>`;
  const end = points.at(-1);
  return `<div class="chart" data-width="${WIDTH}" data-points='${JSON.stringify(points.map(([px, py]) => [Number(px.toFixed(1)), Number(py.toFixed(1))]))}'>
<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label}">${grid}
${entries.length > 1 ? `<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>` : ''}
<line class="chart-crosshair" x1="0" x2="0" y1="${PAD.top}" y2="${baseline}" hidden/>
<circle class="chart-end" cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="4"/>
<circle class="chart-focus" r="5" hidden/>${xLabels}</svg>
<div class="chart-tooltip" hidden></div></div>`;
}

// Nearest-point hover with crosshair and tooltip. The hit area is the whole plot.
export function attachChart(container, entries, describe) {
  const chart = container.querySelector('.chart');
  if (!chart) return;
  const svg = chart.querySelector('svg');
  const points = JSON.parse(chart.dataset.points);
  const WIDTH = Number(chart.dataset.width);
  const crosshair = chart.querySelector('.chart-crosshair');
  const focus = chart.querySelector('.chart-focus');
  const tooltip = chart.querySelector('.chart-tooltip');
  function hide() { crosshair.setAttribute('hidden', ''); focus.setAttribute('hidden', ''); tooltip.hidden = true; }
  chart.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * WIDTH;
    let index = 0;
    points.forEach(([cx], candidate) => { if (Math.abs(cx - px) < Math.abs(points[index][0] - px)) index = candidate; });
    const [cx, cy] = points[index];
    crosshair.setAttribute('x1', cx);
    crosshair.setAttribute('x2', cx);
    crosshair.removeAttribute('hidden');
    focus.setAttribute('cx', cx);
    focus.setAttribute('cy', cy);
    focus.removeAttribute('hidden');
    tooltip.textContent = describe(entries[index], entries[index - 1]);
    tooltip.hidden = false;
    const left = (cx / WIDTH) * box.width;
    // Keep the whole tooltip inside the chart box.
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(left, half), box.width - half)}px`;
    tooltip.style.top = `${(cy / HEIGHT) * box.height}px`;
  });
  chart.addEventListener('pointerleave', hide);
}
