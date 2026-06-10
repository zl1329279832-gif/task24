// MilestoneView - Horizontal timeline showing milestones across projects.
// Milestones are rendered as colored diamonds in project swimlanes with
// connection lines between related milestones and click-for-detail popups.

const SWIMLANE_HEIGHT = 80;
const MILESTONE_SIZE = 18;
const PADDING_LEFT = 160;
const DAY_MS = 86400000;

const STATUS_COLOR_MAP = {
  achieved: '#22c55e',
  'at-risk': '#eab308',
  missed: '#ef4444',
  future: '#94a3b8',
};

/**
 * MilestoneView groups milestones into project swimlanes along a horizontal
 * timeline. Color indicates status: green=achieved, yellow=at-risk,
 * red=missed, gray=future. Clicking a milestone opens a detail popup that
 * also shows downstream task impact.
 */
export class MilestoneView {
  constructor(container, store, optionsOrDeps) {
    this.container = container;
    this.store = store;
    this.deps = optionsOrDeps?.dependencyEngine || optionsOrDeps;

    this._listeners = [];
    this._unsubscribe = null;
    this._popup = null;

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    const projects = this.store.getFilteredProjects();
    const milestones = this._collectMilestones(projects);
    const { minDate, maxDate } = this._dateRange(milestones);
    this._minDate = minDate;
    this._maxDate = maxDate;

    this._renderTimeline(projects, milestones);
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this._closePopup();
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('milestone-container');
    this.container.innerHTML = `
      <div class="milestone-header">
        <h3 class="milestone-title">Milestone Timeline</h3>
        <div class="milestone-legend">
          <span class="milestone-legend-item"><span class="milestone-dot" style="background:#22c55e"></span>Achieved</span>
          <span class="milestone-legend-item"><span class="milestone-dot" style="background:#eab308"></span>At Risk</span>
          <span class="milestone-legend-item"><span class="milestone-dot" style="background:#ef4444"></span>Missed</span>
          <span class="milestone-legend-item"><span class="milestone-dot" style="background:#94a3b8"></span>Future</span>
        </div>
      </div>
      <div class="milestone-body"></div>
    `;
    this._body = this.container.querySelector('.milestone-body');
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Data helpers --------------------------------------------------------

  _collectMilestones(projects) {
    const all = [];
    for (const p of projects) {
      const tasks = this.store.getProjectTasks(p.id);
      for (const t of tasks) {
        if (t.isMilestone) {
          all.push({ ...t, projectName: p.name, projectColor: p.color, projectId: p.id });
        }
      }
    }
    return all;
  }

  _dateRange(milestones) {
    if (!milestones.length) {
      const today = new Date();
      return {
        minDate: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        maxDate: new Date(today.getFullYear(), today.getMonth() + 3, 0),
      };
    }
    let min = Infinity, max = -Infinity;
    for (const m of milestones) {
      const d = new Date(m.milestoneDate || m.plannedEnd).getTime();
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return {
      minDate: new Date(min - 14 * DAY_MS),
      maxDate: new Date(max + 14 * DAY_MS),
    };
  }

  _dateToX(date, totalWidth) {
    const d = (new Date(date).getTime() - this._minDate.getTime()) / DAY_MS;
    const range = (this._maxDate.getTime() - this._minDate.getTime()) / DAY_MS;
    return PADDING_LEFT + (d / range) * (totalWidth - PADDING_LEFT);
  }

  _milestoneStatus(m) {
    const today = new Date();
    const mDate = new Date(m.milestoneDate || m.plannedEnd);
    if (m.status === 'completed') return 'achieved';
    if (mDate < today && m.status !== 'completed') return 'missed';
    const daysUntil = (mDate.getTime() - today.getTime()) / DAY_MS;
    if (daysUntil <= 7 && m.progress < 80) return 'at-risk';
    return 'future';
  }

  // -- Render timeline -----------------------------------------------------

  _renderTimeline(projects, milestones) {
    this._body.innerHTML = '';
    const totalWidth = Math.max(this._body.clientWidth || 900, 900);

    // Date axis
    const axis = document.createElement('div');
    axis.className = 'milestone-axis';
    axis.style.position = 'relative';
    axis.style.height = '32px';
    axis.style.marginLeft = PADDING_LEFT + 'px';

    const cur = new Date(this._minDate);
    while (cur <= this._maxDate) {
      const x = this._dateToX(cur, totalWidth) - PADDING_LEFT;
      const label = document.createElement('span');
      label.className = 'milestone-axis-label';
      label.style.left = x + 'px';
      label.textContent = cur.toLocaleDateString('default', { month: 'short', day: 'numeric' });
      axis.appendChild(label);
      cur.setDate(cur.getDate() + 14);
    }
    this._body.appendChild(axis);

    // Today marker
    const todayX = this._dateToX(new Date(), totalWidth);

    // Swimlanes
    for (const project of projects) {
      const lane = document.createElement('div');
      lane.className = 'milestone-swimlane';
      lane.style.height = SWIMLANE_HEIGHT + 'px';

      // Project label
      const label = document.createElement('div');
      label.className = 'milestone-swimlane-label';
      label.style.width = PADDING_LEFT + 'px';
      label.innerHTML = `<span class="milestone-project-dot" style="background:${project.color}"></span>${project.name}`;
      lane.appendChild(label);

      // Milestone track
      const track = document.createElement('div');
      track.className = 'milestone-track';
      track.style.position = 'relative';
      track.style.flex = '1';
      track.style.height = '100%';

      // Today line
      if (todayX > PADDING_LEFT) {
        const todayLine = document.createElement('div');
        todayLine.className = 'milestone-today-line';
        todayLine.style.left = todayX + 'px';
        track.appendChild(todayLine);
      }

      // Milestones for this project
      const pMilestones = milestones.filter((m) => m.projectId === project.id);
      for (const m of pMilestones) {
        const status = this._milestoneStatus(m);
        const x = this._dateToX(m.milestoneDate || m.plannedEnd, totalWidth);
        const diamond = document.createElement('div');
        diamond.className = 'milestone-diamond';
        diamond.style.left = (x - MILESTONE_SIZE / 2) + 'px';
        diamond.style.top = (SWIMLANE_HEIGHT / 2 - MILESTONE_SIZE / 2) + 'px';
        diamond.style.background = STATUS_COLOR_MAP[status];
        diamond.title = m.name;
        diamond.dataset.milestoneId = m.id;

        this._listen(diamond, 'click', (e) => {
          e.stopPropagation();
          this._showPopup(m, status, diamond);
        });

        // Date label below diamond
        const dateLabel = document.createElement('span');
        dateLabel.className = 'milestone-diamond-label';
        dateLabel.textContent = new Date(m.milestoneDate || m.plannedEnd).toLocaleDateString('default', { month: 'short', day: 'numeric' });
        diamond.appendChild(dateLabel);

        track.appendChild(diamond);
      }

      // Connection lines between consecutive milestones
      for (let i = 0; i < pMilestones.length - 1; i++) {
        const a = pMilestones[i];
        const b = pMilestones[i + 1];
        const x1 = this._dateToX(a.milestoneDate || a.plannedEnd, totalWidth);
        const x2 = this._dateToX(b.milestoneDate || b.plannedEnd, totalWidth);
        const line = document.createElement('div');
        line.className = 'milestone-connector';
        line.style.left = x1 + 'px';
        line.style.width = (x2 - x1) + 'px';
        line.style.top = (SWIMLANE_HEIGHT / 2) + 'px';
        track.appendChild(line);
      }

      lane.appendChild(track);
      this._body.appendChild(lane);
    }
  }

  // -- Popup ---------------------------------------------------------------

  _showPopup(milestone, status) {
    this._closePopup();
    const popup = document.createElement('div');
    popup.className = 'milestone-popup';

    // Downstream impact
    let impactHTML = '';
    try {
      const cp = this.deps.calculateCriticalPath(milestone.projectId);
      if (cp && cp.taskIds) {
        const downstream = cp.taskIds.filter((id) => id !== milestone.id);
        if (downstream.length) {
          impactHTML = `<div class="milestone-popup-section"><strong>Downstream tasks on critical path:</strong><ul>${downstream.map((id) => `<li>${id}</li>`).join('')}</ul></div>`;
        }
      }
    } catch { /* ignore */ }

    popup.innerHTML = `
      <div class="milestone-popup-header">
        <span class="milestone-popup-title">${milestone.name}</span>
        <button class="milestone-popup-close">&times;</button>
      </div>
      <div class="milestone-popup-body">
        <div>Project: ${milestone.projectName}</div>
        <div>Date: ${new Date(milestone.milestoneDate || milestone.plannedEnd).toLocaleDateString()}</div>
        <div>Status: <span class="milestone-status-badge" style="background:${STATUS_COLOR_MAP[status]}">${status}</span></div>
        <div>Progress: ${milestone.progress != null ? milestone.progress + '%' : 'N/A'}</div>
        <div>Assignee: ${milestone.assignee || 'Unassigned'}</div>
        ${impactHTML}
      </div>
    `;

    popup.querySelector('.milestone-popup-close').addEventListener('click', () => this._closePopup());
    this.container.appendChild(popup);
    this._popup = popup;
  }

  _closePopup() {
    if (this._popup) {
      this._popup.remove();
      this._popup = null;
    }
  }
}
