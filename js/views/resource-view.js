// ResourceView - Resource conflict detection and utilization heatmap.
// Displays resource list, conflict alerts, detail timelines, and a
// Canvas-based heatmap grid for allocation over time.

const HEATMAP_CELL_W = 36;
const HEATMAP_CELL_H = 28;

/**
 * ResourceView presents resource utilization, overload alerts, and an
 * allocation heatmap. Clicking a resource opens a detail panel showing
 * the resource's task timeline.
 */
export class ResourceView {
  constructor(container, store, optionsOrEngine) {
    this.container = container;
    this.store = store;
    this.resEngine = optionsOrEngine?.resourceEngine || optionsOrEngine;
    this.baselineManager = optionsOrEngine?.baselineManager || null;

    this._listeners = [];
    this._unsubscribe = null;
    this._selectedResource = null;

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderSummary();
    this._renderResourceList();
    this._renderConflictAlerts();
    this._renderDetailPanel();
    this._renderHeatmap();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('resource-container');
    this.container.innerHTML = `
      <div class="resource-summary"></div>
      <div class="resource-body">
        <div class="resource-sidebar">
          <div class="resource-conflicts">
            <h4 class="resource-section-title">Conflict Alerts</h4>
            <div class="resource-conflict-list"></div>
          </div>
          <div class="resource-list-section">
            <h4 class="resource-section-title">Resources</h4>
            <div class="resource-list"></div>
          </div>
        </div>
        <div class="resource-main">
          <div class="resource-detail"></div>
          <div class="resource-heatmap-wrap">
            <h4 class="resource-section-title">Allocation Heatmap</h4>
            <div class="resource-heatmap"></div>
          </div>
        </div>
      </div>
    `;
    this._els = {
      summary: this.container.querySelector('.resource-summary'),
      conflictList: this.container.querySelector('.resource-conflict-list'),
      list: this.container.querySelector('.resource-list'),
      detail: this.container.querySelector('.resource-detail'),
      heatmap: this.container.querySelector('.resource-heatmap'),
    };
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Summary cards -------------------------------------------------------

  _renderSummary() {
    const resources = Array.from(this.store.state.resources.values());
    const overloaded = this.resEngine.findOverloadedResources();

    let totalUtil = 0;
    for (const r of resources) {
      const alloc = (r.tasks || []).reduce((sum, t) => sum + (t.allocation || 0), 0);
      totalUtil += r.maxCapacity ? Math.min(alloc / r.maxCapacity, 1.5) : 0;
    }
    const avgUtil = resources.length ? Math.round((totalUtil / resources.length) * 100) : 0;

    this._els.summary.innerHTML = `
      <div class="resource-card resource-card-total">
        <div class="resource-card-value">${resources.length}</div>
        <div class="resource-card-label">Total Resources</div>
      </div>
      <div class="resource-card resource-card-overloaded">
        <div class="resource-card-value">${overloaded.length}</div>
        <div class="resource-card-label">Overloaded</div>
      </div>
      <div class="resource-card resource-card-util">
        <div class="resource-card-value">${avgUtil}%</div>
        <div class="resource-card-label">Avg Utilization</div>
      </div>
    `;
  }

  // -- Conflict alerts -----------------------------------------------------

  _renderConflictAlerts() {
    const conflicts = this.resEngine.detectConflicts();
    if (!conflicts.length) {
      this._els.conflictList.innerHTML = '<p class="resource-empty">No conflicts detected.</p>';
      return;
    }
    this._els.conflictList.innerHTML = conflicts.map((c) => `
      <div class="resource-conflict-item">
        <span class="resource-conflict-badge">${c.totalAllocation}%</span>
        <strong>${c.resourceName}</strong> on ${new Date(c.date).toLocaleDateString()}
        <span class="resource-conflict-detail">${c.tasks.length} tasks, capacity ${c.maxCapacity}%</span>
      </div>
    `).join('');
  }

  // -- Resource list -------------------------------------------------------

  _renderResourceList() {
    const resources = Array.from(this.store.state.resources.values());
    const overloaded = this.resEngine.findOverloadedResources();
    const overloadedMap = new Map(overloaded.map((r) => [r.resourceId, r]));

    this._els.list.innerHTML = '';
    for (const r of resources) {
      const alloc = (r.tasks || []).reduce((sum, t) => sum + (t.allocation || 0), 0);
      const util = r.maxCapacity ? Math.round((alloc / r.maxCapacity) * 100) : 0;
      const isOverloaded = overloadedMap.has(r.id);

      const item = document.createElement('div');
      item.className = 'resource-list-item' + (this._selectedResource === r.id ? ' resource-list-item--selected' : '');
      item.innerHTML = `
        <div class="resource-list-item-header">
          <span class="resource-list-item-name">${r.name}</span>
          ${isOverloaded ? '<span class="resource-overload-badge">!</span>' : ''}
        </div>
        <div class="resource-util-bar">
          <div class="resource-util-fill" style="width:${Math.min(util, 100)}%;background:${util > 100 ? '#ef4444' : util > 80 ? '#eab308' : '#22c55e'}"></div>
        </div>
        <span class="resource-util-label">${util}%</span>
      `;

      this._listen(item, 'click', () => {
        this._selectedResource = this._selectedResource === r.id ? null : r.id;
        this._renderResourceList();
        this._renderDetailPanel();
      });

      this._els.list.appendChild(item);
    }
  }

  // -- Detail panel --------------------------------------------------------

  _renderDetailPanel() {
    const panel = this._els.detail;
    if (!this._selectedResource) {
      panel.innerHTML = '<p class="resource-empty">Select a resource to view details.</p>';
      return;
    }
    const resource = this.store.state.resources.get(this._selectedResource);
    if (!resource) { panel.innerHTML = ''; return; }

    const tasks = (resource.tasks || []).map((rt) => {
      const task = this.store.state.tasks.get(rt.taskId);
      const project = this.store.state.projects.get(rt.projectId);
      return { ...rt, task, projectName: project ? project.name : 'Unknown' };
    }).filter((rt) => rt.task);

    // Sort by planned start
    tasks.sort((a, b) => new Date(a.task.plannedStart) - new Date(b.task.plannedStart));

    const totalAlloc = tasks.reduce((s, t) => s + (t.allocation || 0), 0);

    // Overload source breakdown
    let overloadSection = '';
    if (totalAlloc > resource.maxCapacity) {
      const excess = totalAlloc - resource.maxCapacity;
      const sortedTasks = [...tasks].sort((a, b) => b.allocation - a.allocation);
      const barSegments = sortedTasks.map((t) => {
        const pct = Math.round((t.allocation / totalAlloc) * 100);
        const colors = ['#3b82f6', '#e67e22', '#22c55e', '#8b5cf6', '#ef4444', '#eab308'];
        const colorIdx = sortedTasks.indexOf(t) % colors.length;
        return `<div class="resource-overload-segment" style="width:${pct}%;background:${colors[colorIdx]}" title="${t.task.name}: ${t.allocation}%"></div>`;
      }).join('');

      overloadSection = `
        <div class="resource-overload-section">
          <h5 class="resource-section-title">Overload Sources (${totalAlloc}% / ${resource.maxCapacity}%, +${excess}%)</h5>
          <div class="resource-overload-bar">${barSegments}</div>
          <div class="resource-overload-legend">
            ${sortedTasks.map((t, i) => {
              const colors = ['#3b82f6', '#e67e22', '#22c55e', '#8b5cf6', '#ef4444', '#eab308'];
              return `<span class="resource-overload-legend-item"><span class="resource-overload-dot" style="background:${colors[i % colors.length]}"></span>${t.task.name}: ${t.allocation}%</span>`;
            }).join('')}
          </div>
        </div>
      `;
    }

    // Baseline comparison
    let baselineSection = '';
    const baseline = this.baselineManager?.getActiveBaseline?.();
    if (baseline) {
      const baselineResource = (baseline.resources || []).find(r => r.id === resource.id);
      if (baselineResource) {
        const baseAlloc = (baselineResource.tasks || []).reduce((s, t) => s + (t.allocation || 0), 0);
        const delta = totalAlloc - baseAlloc;
        const deltaColor = delta > 0 ? '#dc2626' : delta < 0 ? '#16a34a' : '#64748b';
        const deltaSign = delta > 0 ? '+' : '';
        baselineSection = `
          <div class="resource-baseline-compare">
            <strong>vs Baseline:</strong>
            <span style="color:${deltaColor};font-weight:600;margin-left:8px">${baseAlloc}% &rarr; ${totalAlloc}% (${deltaSign}${delta}%)</span>
          </div>
        `;
      }
    }

    panel.innerHTML = `
      <h4 class="resource-detail-title">${resource.name} &mdash; ${resource.role || ''}</h4>
      <div class="resource-detail-dept">${resource.department || ''}</div>
      <div class="resource-detail-capacity">Max capacity: ${resource.maxCapacity}% | Current: ${totalAlloc}%</div>
      ${baselineSection}
      ${overloadSection}
      <table class="resource-detail-table">
        <thead><tr><th>Task</th><th>Project</th><th>Allocation</th><th>Period</th></tr></thead>
        <tbody>
          ${tasks.map((t) => `
            <tr>
              <td>${t.task.name}</td>
              <td>${t.projectName}</td>
              <td>${t.allocation}%</td>
              <td>${new Date(t.task.plannedStart).toLocaleDateString()} &ndash; ${new Date(t.task.plannedEnd).toLocaleDateString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // -- Heatmap (Canvas) ----------------------------------------------------

  _renderHeatmap() {
    const wrap = this._els.heatmap;
    wrap.innerHTML = '';

    let heatmapData;
    try {
      heatmapData = this.resEngine.getResourceHeatmap();
    } catch {
      wrap.innerHTML = '<p class="resource-empty">Heatmap data unavailable.</p>';
      return;
    }

    const { resources: resList, dates, data } = heatmapData;
    if (!resList || !resList.length || !dates || !dates.length) {
      wrap.innerHTML = '<p class="resource-empty">No heatmap data.</p>';
      return;
    }

    const labelW = 120;
    const totalW = labelW + dates.length * HEATMAP_CELL_W;
    const totalH = 24 + resList.length * HEATMAP_CELL_H;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    const ctx = canvas.getContext('2d');

    // Column headers (dates)
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    dates.forEach((d, i) => {
      const x = labelW + i * HEATMAP_CELL_W + HEATMAP_CELL_W / 2;
      const label = new Date(d).toLocaleDateString('default', { month: 'short', day: 'numeric' });
      ctx.fillText(label, x, 14);
    });

    // Rows
    resList.forEach((resName, ri) => {
      const y = 24 + ri * HEATMAP_CELL_H;
      // Row label
      ctx.fillStyle = '#334155';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(resName, labelW - 6, y + HEATMAP_CELL_H / 2 + 4);

      // Cells
      dates.forEach((d, ci) => {
        const val = (data[ri] && data[ri][ci]) || 0;
        const x = labelW + ci * HEATMAP_CELL_W;
        ctx.fillStyle = this._heatColor(val);
        ctx.fillRect(x, y, HEATMAP_CELL_W - 1, HEATMAP_CELL_H - 1);
      });
    });

    wrap.appendChild(canvas);

    // Tooltip on hover
    this._listen(canvas, 'mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const ci = Math.floor((mx - labelW) / HEATMAP_CELL_W);
      const ri = Math.floor((my - 24) / HEATMAP_CELL_H);
      if (ci >= 0 && ci < dates.length && ri >= 0 && ri < resList.length) {
        const val = (data[ri] && data[ri][ci]) || 0;
        canvas.title = `${resList[ri]} - ${new Date(dates[ci]).toLocaleDateString()}: ${val}% allocated`;
      } else {
        canvas.title = '';
      }
    });
  }

  _heatColor(value) {
    if (value <= 0) return '#f1f5f9';
    if (value <= 50) return '#bbf7d0';
    if (value <= 80) return '#fde68a';
    if (value <= 100) return '#fdba74';
    return '#fca5a5';
  }
}
