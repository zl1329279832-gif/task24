// GanttChart - Full-featured Gantt chart using SVG with Canvas fallback for large datasets.
// Renders project timelines with dependency arrows, critical path highlighting,
// drag-to-move interaction, and virtual scrolling for performance.

const ROW_HEIGHT = 32;
const BAR_HEIGHT = 20;
const HEADER_HEIGHT = 48;
const LEFT_PANEL_RATIO = 0.3;
const TASK_THRESHOLD_CANVAS = 200;
const DAY_MS = 86400000;

const STATUS_COLORS = {
  completed: '#22c55e',
  'not-started': '#94a3b8',
  default: null, // falls back to project.color
};
const CRITICAL_COLOR = '#ef4444';
const TODAY_COLOR = '#ef4444';
const CROSS_PROJECT_COLOR = '#8b5cf6';

/**
 * GanttChart renders a dual-panel timeline view:
 *  - Left panel: scrollable task list grouped by project
 *  - Right panel: SVG (or Canvas for >200 tasks) chart with bars, arrows, and milestones
 */
export class GanttChart {
  constructor(container, store, optionsOrDeps) {
    this.container = container;
    this.store = store;
    this.deps = optionsOrDeps?.dependencyEngine || optionsOrDeps;

    // Interaction state
    this._drag = null;
    this._tooltip = null;
    this._collapsed = new Set();
    this._zoomLevel = 1; // 0.5 = months, 1 = weeks, 2 = days
    this._scrollY = 0;
    this._scrollX = 0;
    this._rafId = null;
    this._listeners = [];
    this._unsubscribe = null;

    this._buildDOM();
    this._bindEvents();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  // -- Public API ----------------------------------------------------------

  render() {
    const projects = this.store.getFilteredProjects();
    const allTasks = this.store.getFilteredTasks();
    this._projects = Array.isArray(projects) ? projects : Array.from(projects.values());
    this._tasks = Array.isArray(allTasks) ? allTasks : Array.from(allTasks.values());
    this._criticalTaskIds = this._collectCriticalTasks();
    this._computeDateRange();
    this._renderLeftPanel();
    this._renderRightPanel();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.container.innerHTML = '';
  }

  // -- DOM construction ----------------------------------------------------

  _buildDOM() {
    this.container.classList.add('gantt-container');
    this.container.innerHTML = `
      <div class="gantt-toolbar">
        <button class="gantt-btn" data-action="zoom-in" title="Zoom In">+</button>
        <button class="gantt-btn" data-action="zoom-out" title="Zoom Out">&minus;</button>
        <button class="gantt-btn" data-action="fit" title="Fit All">Fit</button>
      </div>
      <div class="gantt-body">
        <div class="gantt-left">
          <div class="gantt-left-header">Task</div>
          <div class="gantt-left-list"></div>
        </div>
        <div class="gantt-right">
          <div class="gantt-right-header"></div>
          <div class="gantt-right-body"></div>
        </div>
      </div>
      <div class="gantt-tooltip" style="display:none;position:absolute;z-index:999;background:#fff;border:1px solid #ccc;padding:8px;border-radius:4px;pointer-events:none;font-size:12px;"></div>
    `;
    this._els = {
      leftList: this.container.querySelector('.gantt-left-list'),
      rightHeader: this.container.querySelector('.gantt-right-header'),
      rightBody: this.container.querySelector('.gantt-right-body'),
      tooltip: this.container.querySelector('.gantt-tooltip'),
    };
  }

  // -- Event binding -------------------------------------------------------

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  _bindEvents() {
    // Toolbar buttons
    this._listen(this.container.querySelector('.gantt-toolbar'), 'click', (e) => {
      const action = e.target.dataset.action;
      if (action === 'zoom-in') { this._zoomLevel = Math.min(this._zoomLevel + 0.5, 3); this.render(); }
      if (action === 'zoom-out') { this._zoomLevel = Math.max(this._zoomLevel - 0.5, 0.25); this.render(); }
      if (action === 'fit') { this._zoomLevel = 1; this.render(); }
    });

    // Sync scroll between left and right panels
    const rightBody = this._els.rightBody;
    const leftList = this._els.leftList;
    this._listen(rightBody, 'scroll', () => {
      leftList.scrollTop = rightBody.scrollTop;
      this._scrollY = rightBody.scrollTop;
      this._scrollX = rightBody.scrollLeft;
      this._scheduleRender();
    });
    this._listen(leftList, 'scroll', () => {
      rightBody.scrollTop = leftList.scrollTop;
      this._scrollY = rightBody.scrollTop;
    });
  }

  _scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._renderRightPanel();
    });
  }

  // -- Date range & scale --------------------------------------------------

  _computeDateRange() {
    if (!this._tasks.length) {
      const today = new Date();
      this._minDate = new Date(today.getFullYear(), today.getMonth(), 1);
      this._maxDate = new Date(today.getFullYear(), today.getMonth() + 2, 0);
      this._dayWidth = 28 * this._zoomLevel;
      return;
    }
    let min = Infinity, max = -Infinity;
    for (const t of this._tasks) {
      const s = new Date(t.plannedStart).getTime();
      const e = new Date(t.plannedEnd).getTime();
      if (s < min) min = s;
      if (e > max) max = e;
    }
    // Add 7-day padding on each side
    this._minDate = new Date(min - 7 * DAY_MS);
    this._maxDate = new Date(max + 7 * DAY_MS);
    this._dayWidth = 28 * this._zoomLevel;
  }

  _dateToX(date) {
    const d = (new Date(date).getTime() - this._minDate.getTime()) / DAY_MS;
    return d * this._dayWidth;
  }

  _xToDate(x) {
    const days = x / this._dayWidth;
    return new Date(this._minDate.getTime() + days * DAY_MS);
  }

  _totalWidth() {
    const days = (this._maxDate.getTime() - this._minDate.getTime()) / DAY_MS;
    return days * this._dayWidth;
  }

  // -- Collect critical task IDs -------------------------------------------

  _collectCriticalTasks() {
    const ids = new Set();
    for (const p of (this._projects || [])) {
      try {
        const cp = this.deps.calculateCriticalPath(p.id);
        if (cp && cp.taskIds) cp.taskIds.forEach((id) => ids.add(id));
      } catch { /* project may have no tasks */ }
    }
    return ids;
  }

  // -- Visible row helpers -------------------------------------------------

  _visibleRows() {
    const rows = [];
    for (const project of this._projects) {
      rows.push({ type: 'header', project });
      if (this._collapsed.has(project.id)) continue;
      const tasks = this.store.getProjectTasks(project.id);
      for (const task of tasks) {
        rows.push({ type: 'task', task, project });
      }
    }
    return rows;
  }

  // -- Left panel (task list) ----------------------------------------------

  _renderLeftPanel() {
    const rows = this._visibleRows();
    const frag = document.createDocumentFragment();

    for (const row of rows) {
      const div = document.createElement('div');
      div.className = row.type === 'header' ? 'gantt-row gantt-row-header' : 'gantt-row gantt-row-task';
      div.style.height = ROW_HEIGHT + 'px';
      div.style.lineHeight = ROW_HEIGHT + 'px';

      if (row.type === 'header') {
        const collapsed = this._collapsed.has(row.project.id);
        div.innerHTML = `<span class="gantt-collapse">${collapsed ? '\u25B6' : '\u25BC'}</span>
          <span class="gantt-project-dot" style="background:${row.project.color}"></span>
          <span class="gantt-project-name">${row.project.name}</span>`;
        div.addEventListener('click', () => {
          if (this._collapsed.has(row.project.id)) this._collapsed.delete(row.project.id);
          else this._collapsed.add(row.project.id);
          this.render();
        });
      } else {
        const t = row.task;
        const indent = t.isMilestone ? '\u25C6 ' : '';
        div.innerHTML = `<span class="gantt-task-name" title="${t.name}">${indent}${t.name}</span>`;
      }
      frag.appendChild(div);
    }
    this._els.leftList.innerHTML = '';
    this._els.leftList.appendChild(frag);
  }

  // -- Right panel (chart) -------------------------------------------------

  _renderRightPanel() {
    const rows = this._visibleRows();
    const totalH = rows.length * ROW_HEIGHT;
    const totalW = this._totalWidth();
    const useCanvas = this._tasks.length > TASK_THRESHOLD_CANVAS;

    this._renderHeader(totalW);

    if (useCanvas) {
      this._renderCanvas(rows, totalW, totalH);
    } else {
      this._renderSVG(rows, totalW, totalH);
    }
  }

  _renderHeader(totalW) {
    const hdr = this._els.rightHeader;
    hdr.innerHTML = '';
    hdr.style.width = totalW + 'px';
    hdr.style.height = HEADER_HEIGHT + 'px';

    const scale = this._zoomLevel >= 1.5 ? 'day' : this._zoomLevel >= 0.75 ? 'week' : 'month';
    const cur = new Date(this._minDate);

    while (cur <= this._maxDate) {
      const x = this._dateToX(cur);
      const label = document.createElement('div');
      label.className = 'gantt-header-cell';
      label.style.left = x + 'px';

      if (scale === 'day') {
        label.style.width = this._dayWidth + 'px';
        label.textContent = cur.getDate();
        cur.setDate(cur.getDate() + 1);
      } else if (scale === 'week') {
        const wk = this._dayWidth * 7;
        label.style.width = wk + 'px';
        label.textContent = `${cur.getMonth() + 1}/${cur.getDate()}`;
        cur.setDate(cur.getDate() + 7);
      } else {
        const start = new Date(cur.getFullYear(), cur.getMonth(), 1);
        const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
        const w = this._dateToX(end) - this._dateToX(start) + this._dayWidth;
        label.style.width = w + 'px';
        label.textContent = cur.toLocaleString('default', { month: 'short' });
        cur.setMonth(cur.getMonth() + 1);
      }
      hdr.appendChild(label);
    }
  }

  // -- SVG rendering -------------------------------------------------------

  _renderSVG(rows, totalW, totalH) {
    const body = this._els.rightBody;
    body.innerHTML = '';
    body.style.position = 'relative';

    const wrap = document.createElement('div');
    wrap.style.width = totalW + 'px';
    wrap.style.height = totalH + 'px';
    wrap.style.position = 'relative';

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', totalW);
    svg.setAttribute('height', totalH);
    svg.classList.add('gantt-svg');

    // Today line
    const todayX = this._dateToX(new Date());
    if (todayX >= 0 && todayX <= totalW) {
      const line = document.createElementNS(ns, 'line');
      Object.entries({ x1: todayX, y1: 0, x2: todayX, y2: totalH, stroke: TODAY_COLOR, 'stroke-dasharray': '4 3', 'stroke-width': 1 }).forEach(([k, v]) => line.setAttribute(k, v));
      svg.appendChild(line);
    }

    // Gridlines & task bars
    rows.forEach((row, idx) => {
      const y = idx * ROW_HEIGHT;
      // Alternating row background
      if (idx % 2 === 0) {
        const bg = document.createElementNS(ns, 'rect');
        Object.entries({ x: 0, y, width: totalW, height: ROW_HEIGHT, fill: '#f8fafc' }).forEach(([k, v]) => bg.setAttribute(k, v));
        svg.appendChild(bg);
      }
      if (row.type !== 'task') return;
      this._renderTaskBar(svg, row.task, row.project, y);
    });

    // Dependency arrows
    this._renderDependencyArrows(svg, rows);

    wrap.appendChild(svg);
    body.appendChild(wrap);
  }

  _renderTaskBar(svg, task, project, y) {
    const ns = 'http://www.w3.org/2000/svg';
    const x = this._dateToX(task.plannedStart);
    const w = Math.max(this._dateToX(task.plannedEnd) - x, this._dayWidth);
    const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    const isCritical = this._criticalTaskIds.has(task.id);

    if (task.isMilestone) {
      // Diamond shape for milestones
      const cx = x + this._dayWidth / 2;
      const cy = y + ROW_HEIGHT / 2;
      const size = 7;
      const diamond = document.createElementNS(ns, 'polygon');
      diamond.setAttribute('points', `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`);
      diamond.setAttribute('fill', STATUS_COLORS[task.status] || project.color);
      diamond.setAttribute('stroke', isCritical ? CRITICAL_COLOR : '#333');
      diamond.setAttribute('stroke-width', isCritical ? 2 : 0.5);
      diamond.classList.add('gantt-bar');
      diamond.dataset.taskId = task.id;
      svg.appendChild(diamond);
    } else {
      // Background bar
      const bg = document.createElementNS(ns, 'rect');
      Object.entries({
        x, y: barY, width: w, height: BAR_HEIGHT, rx: 4, ry: 4,
        fill: STATUS_COLORS[task.status] || project.color,
        stroke: isCritical ? CRITICAL_COLOR : 'none',
        'stroke-width': isCritical ? 2 : 0,
        opacity: task.status === 'not-started' ? 0.6 : 1,
      }).forEach(([k, v]) => bg.setAttribute(k, v));
      bg.classList.add('gantt-bar');
      bg.dataset.taskId = task.id;
      svg.appendChild(bg);

      // Progress fill
      if (task.progress > 0 && task.progress <= 100) {
        const pw = w * (task.progress / 100);
        const fill = document.createElementNS(ns, 'rect');
        Object.entries({ x, y: barY, width: pw, height: BAR_HEIGHT, rx: 4, ry: 4, fill: '#000', opacity: 0.2 }).forEach(([k, v]) => fill.setAttribute(k, v));
        fill.style.pointerEvents = 'none';
        svg.appendChild(fill);
      }
    }

    // Interaction: hover tooltip, drag
    const hitArea = document.createElementNS(ns, 'rect');
    Object.entries({ x, y: barY - 2, width: w, height: BAR_HEIGHT + 4, fill: 'transparent' }).forEach(([k, v]) => hitArea.setAttribute(k, v));
    hitArea.style.cursor = 'move';
    hitArea.dataset.taskId = task.id;

    this._listen(hitArea, 'mouseenter', (e) => this._showTooltip(e, task));
    this._listen(hitArea, 'mouseleave', () => this._hideTooltip());
    this._listen(hitArea, 'mousedown', (e) => this._startDrag(e, task, x, barY));
    svg.appendChild(hitArea);
  }

  _renderDependencyArrows(svg, rows) {
    const ns = 'http://www.w3.org/2000/svg';
    const taskRowMap = {};
    rows.forEach((r, idx) => {
      if (r.type === 'task') taskRowMap[r.task.id] = { task: r.task, project: r.project, idx };
    });

    // Standard dependencies
    for (const [, entry] of Object.entries(taskRowMap)) {
      const t = entry.task;
      const depIds = t.dependencies || [];
      for (const depId of depIds) {
        const src = taskRowMap[depId];
        if (!src) continue;
        this._drawArrow(svg, src.task, t, src.idx, entry.idx, false);
      }
      // Cross-project deps
      if (t.crossProjectDeps) {
        for (const cpd of t.crossProjectDeps) {
          const depTaskId = cpd.taskId || cpd;
          const src = taskRowMap[depTaskId];
          if (!src) continue;
          this._drawArrow(svg, src.task, t, src.idx, entry.idx, true);
        }
      }
    }
  }

  _drawArrow(svg, fromTask, toTask, fromIdx, toIdx, isCross) {
    const ns = 'http://www.w3.org/2000/svg';
    const x1 = this._dateToX(fromTask.plannedEnd);
    const y1 = fromIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = this._dateToX(toTask.plannedStart);
    const y2 = toIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
    const midX = (x1 + x2) / 2;

    // Ensure arrowhead marker exists
    if (!svg.querySelector('#gantt-arrowhead')) {
      const defs = document.createElementNS(ns, 'defs');
      const markerColor = isCross ? CROSS_PROJECT_COLOR : '#94a3b8';
      defs.innerHTML = `<marker id="gantt-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${markerColor}"/></marker>`;
      svg.insertBefore(defs, svg.firstChild);
    }

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', isCross ? CROSS_PROJECT_COLOR : '#94a3b8');
    path.setAttribute('stroke-width', 1.5);
    if (isCross) path.setAttribute('stroke-dasharray', '5 3');
    path.setAttribute('marker-end', 'url(#gantt-arrowhead)');
    svg.appendChild(path);
  }

  // -- Canvas fallback (>200 tasks) ----------------------------------------

  _renderCanvas(rows, totalW, totalH) {
    const body = this._els.rightBody;
    body.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    canvas.classList.add('gantt-canvas');
    const ctx = canvas.getContext('2d');

    // Row backgrounds
    rows.forEach((_, idx) => {
      if (idx % 2 === 0) {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, idx * ROW_HEIGHT, totalW, ROW_HEIGHT);
      }
    });

    // Today line
    const todayX = this._dateToX(new Date());
    ctx.strokeStyle = TODAY_COLOR;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(todayX, 0);
    ctx.lineTo(todayX, totalH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Task bars
    rows.forEach((row, idx) => {
      if (row.type !== 'task') return;
      const t = row.task;
      const x = this._dateToX(t.plannedStart);
      const w = Math.max(this._dateToX(t.plannedEnd) - x, this._dayWidth);
      const y = idx * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
      const isCritical = this._criticalTaskIds.has(t.id);

      ctx.fillStyle = STATUS_COLORS[t.status] || row.project.color;
      ctx.globalAlpha = t.status === 'not-started' ? 0.6 : 1;
      this._roundRect(ctx, x, y, w, BAR_HEIGHT, 4);
      ctx.fill();

      if (isCritical) {
        ctx.strokeStyle = CRITICAL_COLOR;
        ctx.lineWidth = 2;
        this._roundRect(ctx, x, y, w, BAR_HEIGHT, 4);
        ctx.stroke();
      }

      // Progress overlay
      if (t.progress > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        this._roundRect(ctx, x, y, w * (t.progress / 100), BAR_HEIGHT, 4);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    body.appendChild(canvas);
    // Canvas click for drag (simplified)
    this._listen(canvas, 'mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left + body.scrollLeft;
      const my = e.clientY - rect.top;
      const rowIdx = Math.floor(my / ROW_HEIGHT);
      const row = rows[rowIdx];
      if (row && row.type === 'task') {
        this._startDrag(e, row.task, this._dateToX(row.task.plannedStart), rowIdx * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2);
      }
    });
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // -- Drag interaction ----------------------------------------------------

  _startDrag(e, task, startX, barY) {
    e.preventDefault();
    this._drag = {
      taskId: task.id,
      taskName: task.name,
      origStart: new Date(task.plannedStart),
      origEnd: new Date(task.plannedEnd),
      startClientX: e.clientX,
      startX,
      barY,
    };

    const onMove = (ev) => this._onDrag(ev);
    const onUp = (ev) => {
      this._endDrag(ev);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  _onDrag(e) {
    if (!this._drag) return;
    const dx = e.clientX - this._drag.startClientX;
    const dayOffset = Math.round(dx / this._dayWidth);
    const newStart = new Date(this._drag.origStart.getTime() + dayOffset * DAY_MS);
    const newEnd = new Date(this._drag.origEnd.getTime() + dayOffset * DAY_MS);
    this._drag.currentStart = newStart;
    this._drag.currentEnd = newEnd;
    this._drag.dayOffset = dayOffset;

    // Visual feedback via transform on the SVG element or redraw canvas
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      const bar = this._els.rightBody.querySelector(`[data-task-id="${this._drag.taskId}"]`);
      if (bar && bar.tagName === 'rect') {
        const newX = this._drag.startX + dayOffset * this._dayWidth;
        bar.setAttribute('x', newX);
      }
    });
  }

  _endDrag() {
    if (!this._drag) return;
    const { taskId, dayOffset, currentStart, currentEnd } = this._drag;
    this._drag = null;

    if (!dayOffset || !currentStart) { this.render(); return; }

    this.store.moveTask(taskId, currentStart, currentEnd);

    // Propagate downstream
    try {
      this.deps.propagateChanges(taskId, currentStart.toISOString().slice(0, 10), currentEnd.toISOString().slice(0, 10));
    } catch { /* circular or missing dep */ }

    this.render();
  }

  // -- Tooltip -------------------------------------------------------------

  _showTooltip(e, task) {
    const tip = this._els.tooltip;
    const status = task.status || 'unknown';
    const progress = task.progress != null ? task.progress + '%' : 'N/A';
    tip.innerHTML = `
      <strong>${task.name}</strong><br/>
      Status: ${status} &bull; Progress: ${progress}<br/>
      Start: ${new Date(task.plannedStart).toLocaleDateString()}<br/>
      End: ${new Date(task.plannedEnd).toLocaleDateString()}<br/>
      Assignee: ${task.assignee || 'Unassigned'}<br/>
      Priority: ${task.priority || 'N/A'}
    `;
    tip.style.display = 'block';
    tip.style.left = e.clientX + 12 + 'px';
    tip.style.top = e.clientY + 12 + 'px';
  }

  _hideTooltip() {
    this._els.tooltip.style.display = 'none';
  }
}
