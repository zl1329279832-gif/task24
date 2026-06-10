// DelayHeatmap - Heatmap showing delay patterns across projects and time.
// Uses Canvas for the grid with HTML overlay for tooltips and interactions.
// Supports toggling between project view and department view.

const CELL_W = 40;
const CELL_H = 32;
const LABEL_W = 140;
const HEADER_H = 36;
const DAY_MS = 86400000;

const COLOR_SCALE = [
  { max: 0, color: '#22c55e', label: 'On track' },
  { max: 3, color: '#eab308', label: '1-3 days' },
  { max: 7, color: '#f97316', label: '4-7 days' },
  { max: Infinity, color: '#ef4444', label: '>7 days' },
];

/**
 * DelayHeatmap displays a color-coded grid where rows represent projects
 * or departments and columns represent time periods. Cell color intensity
 * reflects the severity of delays in that intersection.
 */
export class DelayHeatmap {
  constructor(container, store, optionsOrDeps) {
    this.container = container;
    this.store = store;
    this.deps = optionsOrDeps?.dependencyEngine || optionsOrDeps;

    this._listeners = [];
    this._unsubscribe = null;
    this._viewMode = 'project'; // 'project' | 'department'
    this._timeRange = 'month';  // 'week' | 'month'
    this._cellPopup = null;

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderControls();
    this._renderSummary();
    this._renderGrid();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this._closePopup();
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('heatmap-container');
    this.container.innerHTML = `
      <div class="delay-controls"></div>
      <div class="delay-summary"></div>
      <div class="delay-grid-wrap"></div>
      <div class="delay-legend">
        <span class="delay-legend-title">Delay Severity:</span>
        ${COLOR_SCALE.map((c) => `<span class="delay-legend-item"><span class="delay-legend-swatch" style="background:${c.color}"></span>${c.label}</span>`).join('')}
      </div>
    `;
    this._els = {
      controls: this.container.querySelector('.delay-controls'),
      summary: this.container.querySelector('.delay-summary'),
      gridWrap: this.container.querySelector('.delay-grid-wrap'),
    };
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Controls ------------------------------------------------------------

  _renderControls() {
    this._els.controls.innerHTML = `
      <div class="delay-toggle">
        <button class="delay-btn ${this._viewMode === 'project' ? 'delay-btn--active' : ''}" data-mode="project">By Project</button>
        <button class="delay-btn ${this._viewMode === 'department' ? 'delay-btn--active' : ''}" data-mode="department">By Department</button>
      </div>
      <div class="delay-time-range">
        <button class="delay-btn ${this._timeRange === 'week' ? 'delay-btn--active' : ''}" data-range="week">Weeks</button>
        <button class="delay-btn ${this._timeRange === 'month' ? 'delay-btn--active' : ''}" data-range="month">Months</button>
      </div>
    `;

    this._listen(this._els.controls, 'click', (e) => {
      const mode = e.target.dataset.mode;
      const range = e.target.dataset.range;
      if (mode) this._viewMode = mode;
      if (range) this._timeRange = range;
      this.render();
    });
  }

  // -- Summary statistics --------------------------------------------------

  _renderSummary() {
    const { delays } = this._computeDelays();
    if (!delays.length) {
      this._els.summary.innerHTML = '<p class="delay-empty">No delay data available.</p>';
      return;
    }

    // Most delayed project
    const projDelayMap = {};
    for (const d of delays) {
      if (!projDelayMap[d.projectName]) projDelayMap[d.projectName] = 0;
      projDelayMap[d.projectName] = Math.max(projDelayMap[d.projectName], d.delay);
    }
    const mostDelayed = Object.entries(projDelayMap).sort((a, b) => b[1] - a[1])[0];

    // Average delay
    const avg = Math.round(delays.reduce((s, d) => s + d.delay, 0) / delays.length * 10) / 10;

    // Trend: compare recent period delays to earlier
    const mid = Math.floor(delays.length / 2);
    const earlyAvg = mid ? delays.slice(0, mid).reduce((s, d) => s + d.delay, 0) / mid : 0;
    const lateAvg = mid ? delays.slice(mid).reduce((s, d) => s + d.delay, 0) / (delays.length - mid) : 0;
    const trend = lateAvg > earlyAvg ? '\u2191 Worsening' : lateAvg < earlyAvg ? '\u2193 Improving' : '\u2192 Stable';

    this._els.summary.innerHTML = `
      <div class="delay-stat-card">
        <div class="delay-stat-value">${mostDelayed ? mostDelayed[0] : 'N/A'}</div>
        <div class="delay-stat-label">Most Delayed Project</div>
      </div>
      <div class="delay-stat-card">
        <div class="delay-stat-value">${avg} days</div>
        <div class="delay-stat-label">Average Delay</div>
      </div>
      <div class="delay-stat-card">
        <div class="delay-stat-value">${trend}</div>
        <div class="delay-stat-label">Trend</div>
      </div>
    `;
  }

  // -- Data computation ----------------------------------------------------

  _computeDelays() {
    const projects = this.store.getFilteredProjects();
    const tasks = this.store.getFilteredTasks();
    const delays = [];

    for (const task of tasks) {
      let delay = 0;
      try { delay = this.deps.calculateDelay(task.id) || 0; } catch { /* skip */ }
      const project = projects.find((p) => p.id === task.projectId);
      delays.push({
        taskId: task.id,
        taskName: task.name,
        projectId: task.projectId,
        projectName: project ? project.name : 'Unknown',
        department: project ? project.department : 'Unknown',
        delay,
        plannedStart: task.plannedStart,
        plannedEnd: task.plannedEnd,
      });
    }

    return { delays, projects };
  }

  _buildPeriods() {
    const tasks = this.store.getFilteredTasks();
    if (!tasks.length) return [];

    let minDate = Infinity, maxDate = -Infinity;
    for (const t of tasks) {
      const s = new Date(t.plannedStart).getTime();
      const e = new Date(t.plannedEnd).getTime();
      if (s < minDate) minDate = s;
      if (e > maxDate) maxDate = e;
    }

    const periods = [];
    const cur = new Date(minDate);
    cur.setDate(1); // Start of month

    while (cur.getTime() <= maxDate + 30 * DAY_MS) {
      if (this._timeRange === 'month') {
        const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
        periods.push({ start: new Date(cur), end, label: cur.toLocaleString('default', { month: 'short' }) });
        cur.setMonth(cur.getMonth() + 1);
      } else {
        const end = new Date(cur.getTime() + 7 * DAY_MS);
        periods.push({ start: new Date(cur), end, label: `${cur.getMonth() + 1}/${cur.getDate()}` });
        cur.setDate(cur.getDate() + 7);
      }
    }
    return periods;
  }

  // -- Grid rendering (Canvas) ---------------------------------------------

  _renderGrid() {
    const wrap = this._els.gridWrap;
    wrap.innerHTML = '';
    this._closePopup();

    const { delays } = this._computeDelays();
    const periods = this._buildPeriods();
    if (!delays.length || !periods.length) {
      wrap.innerHTML = '<p class="delay-empty">No data to display.</p>';
      return;
    }

    // Build row labels
    let rowLabels;
    if (this._viewMode === 'project') {
      const names = [...new Set(delays.map((d) => d.projectName))];
      rowLabels = names.sort();
    } else {
      const names = [...new Set(delays.map((d) => d.department))];
      rowLabels = names.sort();
    }

    // Compute max delay per cell
    const cellData = rowLabels.map(() => periods.map(() => ({ maxDelay: 0, tasks: [] })));
    for (const d of delays) {
      const ri = rowLabels.indexOf(this._viewMode === 'project' ? d.projectName : d.department);
      if (ri < 0) continue;
      for (let ci = 0; ci < periods.length; ci++) {
        const p = periods[ci];
        const taskEnd = new Date(d.plannedEnd);
        if (taskEnd >= p.start && taskEnd <= p.end) {
          cellData[ri][ci].maxDelay = Math.max(cellData[ri][ci].maxDelay, d.delay);
          cellData[ri][ci].tasks.push(d);
        }
      }
    }

    // Canvas
    const totalW = LABEL_W + periods.length * CELL_W;
    const totalH = HEADER_H + rowLabels.length * CELL_H;
    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    const ctx = canvas.getContext('2d');

    // Column headers
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    periods.forEach((p, ci) => {
      const x = LABEL_W + ci * CELL_W + CELL_W / 2;
      ctx.fillText(p.label, x, HEADER_H - 8);
    });

    // Row labels and cells
    rowLabels.forEach((label, ri) => {
      const y = HEADER_H + ri * CELL_H;
      ctx.fillStyle = '#334155';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(label, LABEL_W - 8, y + CELL_H / 2 + 4);

      periods.forEach((_, ci) => {
        const x = LABEL_W + ci * CELL_W;
        const cell = cellData[ri][ci];
        ctx.fillStyle = this._delayColor(cell.maxDelay);
        ctx.fillRect(x, y, CELL_W - 1, CELL_H - 1);
      });
    });

    wrap.appendChild(canvas);

    // Click handler for cell detail
    this._listen(canvas, 'click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const ci = Math.floor((mx - LABEL_W) / CELL_W);
      const ri = Math.floor((my - HEADER_H) / CELL_H);
      if (ci >= 0 && ci < periods.length && ri >= 0 && ri < rowLabels.length) {
        const cell = cellData[ri][ci];
        if (cell.tasks.length) {
          this._showCellPopup(cell, rowLabels[ri], periods[ci], e.clientX, e.clientY);
        }
      }
    });
  }

  _delayColor(delayDays) {
    if (delayDays <= 0) return '#dcfce7'; // light green
    if (delayDays <= 3) return '#fef9c3';  // light yellow
    if (delayDays <= 7) return '#fed7aa';  // light orange
    return '#fecaca';                       // light red
  }

  // -- Cell popup ----------------------------------------------------------

  _showCellPopup(cell, rowLabel, period, x, y) {
    this._closePopup();
    const popup = document.createElement('div');
    popup.className = 'delay-popup';
    popup.style.left = x + 12 + 'px';
    popup.style.top = y + 12 + 'px';

    popup.innerHTML = `
      <div class="delay-popup-header">
        <strong>${rowLabel}</strong> &mdash; ${period.label}
        <button class="delay-popup-close">&times;</button>
      </div>
      <div class="delay-popup-body">
        <div>Max delay: ${cell.maxDelay} days</div>
        <div>Tasks (${cell.tasks.length}):</div>
        <ul>
          ${cell.tasks.map((t) => `<li>${t.taskName} <span class="delay-popup-delay">(${t.delay}d delay)</span></li>`).join('')}
        </ul>
      </div>
    `;

    popup.querySelector('.delay-popup-close').addEventListener('click', () => this._closePopup());
    this.container.appendChild(popup);
    this._cellPopup = popup;
  }

  _closePopup() {
    if (this._cellPopup) {
      this._cellPopup.remove();
      this._cellPopup = null;
    }
  }
}
