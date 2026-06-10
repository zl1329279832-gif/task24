// Toolbar - Top toolbar with view switcher, undo/redo, scenario management,
// baseline management, change requests, import/export, and live stats.

const VIEWS = [
  { id: 'gantt', label: 'Gantt', icon: '\u25A4' },
  { id: 'milestone', label: 'Milestones', icon: '\u25C6' },
  { id: 'resource', label: 'Resources', icon: '\u2630' },
  { id: 'heatmap', label: 'Heatmap', icon: '\u25A6' },
  { id: 'risk', label: 'Risk Matrix', icon: '\u26A0' },
];

/**
 * Toolbar provides the top-level action bar with view switching tabs,
 * undo/redo controls, scenario management, baseline management,
 * change request drafts, CSV import, report export, and live stats.
 */
export class Toolbar {
  constructor(container, store, historyManager, riskEngine, options) {
    this.container = container;
    this.store = store;
    this.history = historyManager;
    this.riskEngine = riskEngine;
    this.baselineManager = options?.baselineManager || null;
    this.changeRequestManager = options?.changeRequestManager || null;
    this.changeImpactEngine = options?.changeImpactEngine || null;

    this._listeners = [];
    this._unsubscribe = null;
    this._unsubBaseline = null;
    this._scenarioMenuOpen = false;
    this._exportMenuOpen = false;
    this._baselineMenuOpen = false;

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
    if (this.baselineManager) {
      this._unsubBaseline = this.baselineManager.subscribe(() => this._renderBaselineMenu());
    }
  }

  render() {
    this._renderViewTabs();
    this._renderUndoRedo();
    this._renderStats();
    this._renderScenarioMenu();
    this._renderBaselineIndicator();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._unsubBaseline) this._unsubBaseline();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('toolbar-inner');
    this.container.innerHTML = `
      <div class="toolbar-row">
        <div class="toolbar-left">
          <div class="toolbar-import">
            <button class="toolbar-btn toolbar-btn-import" title="Import CSV">\u{1F4C2} Import</button>
          </div>
          <div class="toolbar-views"></div>
        </div>
        <div class="toolbar-center">
          <div class="toolbar-undo-redo">
            <button class="toolbar-btn toolbar-btn-undo" title="Undo (Ctrl+Z)">\u21B6 Undo</button>
            <button class="toolbar-btn toolbar-btn-redo" title="Redo (Ctrl+Y)">\u21B7 Redo</button>
          </div>
          <div class="toolbar-scenario">
            <button class="toolbar-btn toolbar-btn-save-scenario" title="Save Scenario (Ctrl+S)">\u{1F4BE} Save</button>
            <button class="toolbar-btn toolbar-btn-load-scenario">\u25BC Load</button>
            <div class="toolbar-scenario-menu" style="display:none"></div>
          </div>
          <div class="toolbar-baseline">
            <button class="toolbar-btn toolbar-btn-save-baseline" title="Save current state as baseline">\u{1F4CC} Baseline</button>
            <button class="toolbar-btn toolbar-btn-baseline-menu">\u25BC Manage</button>
            <div class="toolbar-baseline-menu" style="display:none"></div>
          </div>
          <div class="toolbar-baseline-actions">
            <button class="toolbar-btn toolbar-btn-impact" title="Show impact analysis vs active baseline">\u{1F4CA} Impact</button>
            <button class="toolbar-btn toolbar-btn-change-req" title="Create change request draft">\u{1F4DD} Change Req</button>
          </div>
          <div class="toolbar-baseline-indicator"></div>
          <div class="toolbar-export">
            <button class="toolbar-btn toolbar-btn-export">\u{1F4E4} Export \u25BC</button>
            <div class="toolbar-export-menu" style="display:none">
              <button class="toolbar-menu-item" data-export="csv">Risk Report CSV</button>
              <button class="toolbar-menu-item" data-export="html">Risk Report HTML</button>
              <button class="toolbar-menu-item" data-export="baselines">Export Baselines</button>
              <button class="toolbar-menu-item" data-export="import-baselines">Import Baselines</button>
            </div>
          </div>
        </div>
        <div class="toolbar-right">
          <div class="toolbar-stats"></div>
          <a class="toolbar-sample-link" href="#" title="Download sample data">\u{1F4E5} Sample</a>
        </div>
      </div>
    `;

    this._els = {
      views: this.container.querySelector('.toolbar-views'),
      undoBtn: this.container.querySelector('.toolbar-btn-undo'),
      redoBtn: this.container.querySelector('.toolbar-btn-redo'),
      importBtn: this.container.querySelector('.toolbar-btn-import'),
      saveScenario: this.container.querySelector('.toolbar-btn-save-scenario'),
      loadScenario: this.container.querySelector('.toolbar-btn-load-scenario'),
      scenarioMenu: this.container.querySelector('.toolbar-scenario-menu'),
      saveBaseline: this.container.querySelector('.toolbar-btn-save-baseline'),
      baselineMenuBtn: this.container.querySelector('.toolbar-btn-baseline-menu'),
      baselineMenu: this.container.querySelector('.toolbar-baseline-menu'),
      baselineIndicator: this.container.querySelector('.toolbar-baseline-indicator'),
      impactBtn: this.container.querySelector('.toolbar-btn-impact'),
      changeReqBtn: this.container.querySelector('.toolbar-btn-change-req'),
      exportBtn: this.container.querySelector('.toolbar-btn-export'),
      exportMenu: this.container.querySelector('.toolbar-export-menu'),
      stats: this.container.querySelector('.toolbar-stats'),
      sampleLink: this.container.querySelector('.toolbar-sample-link'),
    };

    this._bindButtons();
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Button bindings -----------------------------------------------------

  _bindButtons() {
    // Undo/Redo
    this._listen(this._els.undoBtn, 'click', () => {
      if (this.history.canUndo()) this.history.undo();
    });
    this._listen(this._els.redoBtn, 'click', () => {
      if (this.history.canRedo()) this.history.redo();
    });

    // Import CSV
    this._listen(this._els.importBtn, 'click', () => {
      document.dispatchEvent(new CustomEvent('app:import'));
    });

    // Save scenario
    this._listen(this._els.saveScenario, 'click', () => {
      const name = prompt('Scenario name:', `Scenario ${new Date().toLocaleDateString()}`);
      if (name) this.store.saveScenario(name);
    });

    // Load scenario toggle
    this._listen(this._els.loadScenario, 'click', (e) => {
      e.stopPropagation();
      this._scenarioMenuOpen = !this._scenarioMenuOpen;
      this._renderScenarioMenu();
    });

    // --- Baseline buttons ---

    // Save baseline
    this._listen(this._els.saveBaseline, 'click', () => {
      if (!this.baselineManager) return;
      const name = prompt('Baseline name:', `Baseline ${new Date().toLocaleDateString('zh-CN')}`);
      if (name) {
        const desc = prompt('Description (optional):', '');
        const id = this.baselineManager.createBaseline(name, desc || '');
        this.baselineManager.save();
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: `Baseline "${name}" saved`, type: 'success' } }));
        this._renderBaselineIndicator();
      }
    });

    // Baseline menu toggle
    this._listen(this._els.baselineMenuBtn, 'click', (e) => {
      e.stopPropagation();
      this._baselineMenuOpen = !this._baselineMenuOpen;
      this._renderBaselineMenu();
    });

    // Impact analysis
    this._listen(this._els.impactBtn, 'click', () => {
      if (!this.changeImpactEngine || !this.baselineManager) return;
      const baseline = this.baselineManager.getActiveBaseline();
      if (!baseline) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Please select an active baseline first', type: 'warning' } }));
        return;
      }
      const impact = this.changeImpactEngine.calculateImpact(baseline);
      this._showImpactModal(impact);
    });

    // Create change request
    this._listen(this._els.changeReqBtn, 'click', () => {
      if (!this.changeRequestManager || !this.baselineManager) return;
      if (!this.baselineManager.getActiveBaselineId()) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Please select an active baseline first', type: 'warning' } }));
        return;
      }
      const title = prompt('Change Request title:', `CR-${new Date().toISOString().slice(0, 10)}`);
      if (!title) return;
      const desc = prompt('Description:', '');
      const result = this.changeRequestManager.createDraft(title, desc || '', '');
      if (result.error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: result.error, type: 'error' } }));
      } else {
        this.changeRequestManager.save();
        // Export and download
        const html = this.changeRequestManager.exportDraft(result.id);
        if (html) {
          this._downloadBlob(html, `change-request-${result.id.slice(0, 8)}.html`, 'text/html');
        }
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Change request draft created', type: 'success' } }));
      }
    });

    // Export dropdown toggle
    this._listen(this._els.exportBtn, 'click', (e) => {
      e.stopPropagation();
      this._exportMenuOpen = !this._exportMenuOpen;
      this._els.exportMenu.style.display = this._exportMenuOpen ? 'block' : 'none';
    });

    // Export menu items
    this._listen(this._els.exportMenu, 'click', (e) => {
      const type = e.target.dataset.export;
      if (type === 'html') this._exportHTML();
      if (type === 'csv') this._exportCSV();
      if (type === 'baselines') this._exportBaselines();
      if (type === 'import-baselines') this._importBaselines();
      this._exportMenuOpen = false;
      this._els.exportMenu.style.display = 'none';
    });

    // Close menus on outside click
    this._listen(document, 'click', () => {
      if (this._scenarioMenuOpen) { this._scenarioMenuOpen = false; this._renderScenarioMenu(); }
      if (this._exportMenuOpen) { this._exportMenuOpen = false; this._els.exportMenu.style.display = 'none'; }
      if (this._baselineMenuOpen) { this._baselineMenuOpen = false; this._renderBaselineMenu(); }
    });

    // Sample data link
    this._listen(this._els.sampleLink, 'click', (e) => {
      e.preventDefault();
      this._downloadSampleData();
    });
  }

  // -- View tabs -----------------------------------------------------------

  _renderViewTabs() {
    const currentView = this.store.state.view || 'gantt';
    this._els.views.innerHTML = VIEWS.map((v) => `
      <button class="toolbar-tab ${currentView === v.id ? 'active' : ''}" data-view="${v.id}">
        <span class="toolbar-tab-icon">${v.icon}</span> ${v.label}
      </button>
    `).join('');

    this._els.views.querySelectorAll('.toolbar-tab').forEach((tab) => {
      this._listen(tab, 'click', (e) => {
        e.stopPropagation();
        document.dispatchEvent(new CustomEvent('app:switch-view', { detail: { view: tab.dataset.view } }));
      });
    });
  }

  // -- Undo/Redo state -----------------------------------------------------

  _renderUndoRedo() {
    this._els.undoBtn.disabled = !this.history.canUndo();
    this._els.redoBtn.disabled = !this.history.canRedo();
  }

  // -- Stats display -------------------------------------------------------

  _renderStats() {
    let stats;
    try {
      stats = this.store.getStats();
    } catch {
      stats = {};
    }
    const projects = stats.totalProjects ?? this.store.state.projects?.size ?? 0;
    const tasks = stats.totalTasks ?? this.store.state.tasks?.size ?? 0;
    const delayed = stats.delayedTasks ?? 0;
    const criticalRisks = stats.criticalRisks ?? 0;

    this._els.stats.innerHTML = `
      <span class="toolbar-stat"><span class="toolbar-stat-value">${projects}</span> Projects</span>
      <span class="toolbar-stat"><span class="toolbar-stat-value">${tasks}</span> Tasks</span>
      <span class="toolbar-stat toolbar-stat--warn"><span class="toolbar-stat-value">${delayed}</span> Delayed</span>
      <span class="toolbar-stat toolbar-stat--danger"><span class="toolbar-stat-value">${criticalRisks}</span> Critical</span>
    `;
  }

  // -- Scenario menu -------------------------------------------------------

  _renderScenarioMenu() {
    const menu = this._els.scenarioMenu;
    menu.style.display = this._scenarioMenuOpen ? 'block' : 'none';
    if (!this._scenarioMenuOpen) return;

    let scenarios;
    try { scenarios = this.store.getScenarios() || []; } catch { scenarios = []; }

    if (!scenarios.length) {
      menu.innerHTML = '<div class="toolbar-scenario-empty">No saved scenarios.</div>';
      return;
    }

    menu.innerHTML = scenarios.map((s, idx) => `
      <button class="toolbar-menu-item" data-scenario-idx="${idx}">${s.name || `Scenario ${idx + 1}`}</button>
    `).join('');

    menu.querySelectorAll('.toolbar-menu-item').forEach((item) => {
      this._listen(item, 'click', (e) => {
        e.stopPropagation();
        const idx = parseInt(item.dataset.scenarioIdx, 10);
        this.store.loadScenario(idx);
        this._scenarioMenuOpen = false;
        this._renderScenarioMenu();
      });
    });
  }

  // -- Baseline menu -------------------------------------------------------

  _renderBaselineMenu() {
    const menu = this._els.baselineMenu;
    menu.style.display = this._baselineMenuOpen ? 'block' : 'none';
    if (!this._baselineMenuOpen || !this.baselineManager) return;

    const baselines = this.baselineManager.listBaselines();
    const activeId = this.baselineManager.getActiveBaselineId();

    if (!baselines.length) {
      menu.innerHTML = '<div class="toolbar-menu-empty">No baselines saved.</div>';
      return;
    }

    menu.innerHTML = baselines.map((bl) => `
      <div class="toolbar-baseline-item ${bl.id === activeId ? 'toolbar-baseline-item--active' : ''}" data-bl-id="${bl.id}">
        <div class="toolbar-baseline-item-header">
          <label class="toolbar-baseline-radio">
            <input type="radio" name="active-bl" value="${bl.id}" ${bl.id === activeId ? 'checked' : ''} />
            <span class="toolbar-baseline-name">${bl.name}</span>
          </label>
          <span class="toolbar-baseline-date">${new Date(bl.createdAt).toLocaleDateString('zh-CN')}</span>
        </div>
        <div class="toolbar-baseline-actions-row">
          <button class="toolbar-baseline-action" data-bl-action="restore" data-bl-id="${bl.id}" title="Restore this baseline">Restore</button>
          <button class="toolbar-baseline-action" data-bl-action="export" data-bl-id="${bl.id}" title="Export as JSON">Export</button>
          <button class="toolbar-baseline-action toolbar-baseline-action--danger" data-bl-action="delete" data-bl-id="${bl.id}" title="Delete">Delete</button>
        </div>
      </div>
    `).join('');

    // Radio: set active baseline
    menu.querySelectorAll('input[name="active-bl"]').forEach((radio) => {
      this._listen(radio, 'change', (e) => {
        e.stopPropagation();
        this.baselineManager.setActiveBaseline(radio.value);
        this.baselineManager.save();
        this._renderBaselineMenu();
        this._renderBaselineIndicator();
      });
    });

    // Action buttons
    menu.querySelectorAll('.toolbar-baseline-action').forEach((btn) => {
      this._listen(btn, 'click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.blAction;
        const id = btn.dataset.blId;
        if (action === 'restore') {
          if (confirm('Restore this baseline? Current data will be replaced.')) {
            this.baselineManager.restoreBaseline(id);
            this.baselineManager.save();
            document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Baseline restored', type: 'success' } }));
          }
        } else if (action === 'export') {
          const json = this.baselineManager.exportBaseline(id);
          if (json) this._downloadBlob(json, `baseline-${id.slice(0, 8)}.json`, 'application/json');
        } else if (action === 'delete') {
          if (confirm('Delete this baseline?')) {
            this.baselineManager.deleteBaseline(id);
            this.baselineManager.save();
            this._renderBaselineMenu();
            this._renderBaselineIndicator();
          }
        }
      });
    });
  }

  // -- Baseline indicator --------------------------------------------------

  _renderBaselineIndicator() {
    const el = this._els.baselineIndicator;
    if (!this.baselineManager) { el.innerHTML = ''; return; }
    const info = this.baselineManager.getActiveBaselineInfo();
    if (info) {
      el.innerHTML = `<span class="toolbar-baseline-badge" title="Comparing against: ${info.name}">\u{1F4CC} ${info.name}</span>`;
      // Click to clear
      const badge = el.querySelector('.toolbar-baseline-badge');
      if (badge) {
        this._listen(badge, 'click', (e) => {
          e.stopPropagation();
          this.baselineManager.setActiveBaseline(null);
          this.baselineManager.save();
          this._renderBaselineIndicator();
          document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Baseline comparison cleared', type: 'info' } }));
        });
      }
    } else {
      el.innerHTML = '';
    }
  }

  // -- Impact analysis modal -----------------------------------------------

  _showImpactModal(impact) {
    const s = impact.summary;
    const esc = (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const delayedTasks = impact.taskDelays
      .filter(d => d.delayDays > 0 && !d.isNew && !d.isRemoved)
      .sort((a, b) => b.delayDays - a.delayDays)
      .slice(0, 10);

    const escalatedRisks = impact.riskLevelChanges.filter(r => r.escalated);
    const newOverloads = impact.resourceOverloadChanges.filter(r => r.currentOverloaded && !r.baselineOverloaded);

    const content = document.createElement('div');
    content.innerHTML = `
      <div class="impact-modal">
        <div class="impact-modal-header">
          <h3>Impact Analysis vs Baseline</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="impact-summary-grid">
          <div class="impact-card"><div class="impact-card-value ${s.totalDelayedTasks > 0 ? 'impact-warn' : ''}">${s.totalDelayedTasks}</div><div class="impact-card-label">Delayed Tasks</div></div>
          <div class="impact-card"><div class="impact-card-value ${s.maxDelayDays > 5 ? 'impact-danger' : ''}">${s.maxDelayDays}d</div><div class="impact-card-label">Max Delay</div></div>
          <div class="impact-card"><div class="impact-card-value">${s.criticalPathLengthDelta > 0 ? '+' : ''}${s.criticalPathLengthDelta}d</div><div class="impact-card-label">CP Delta</div></div>
          <div class="impact-card"><div class="impact-card-value ${s.newOverloads > 0 ? 'impact-danger' : ''}">${s.newOverloads}</div><div class="impact-card-label">New Overloads</div></div>
          <div class="impact-card"><div class="impact-card-value ${s.escalatedRisks > 0 ? 'impact-danger' : ''}">${s.escalatedRisks}</div><div class="impact-card-label">Escalated Risks</div></div>
          <div class="impact-card"><div class="impact-card-value">${s.newTasks}</div><div class="impact-card-label">New Tasks</div></div>
        </div>

        ${delayedTasks.length ? `
        <h4>Top Delayed Tasks</h4>
        <table class="impact-table">
          <thead><tr><th>Task</th><th>Project</th><th>Baseline End</th><th>Current End</th><th>Delay</th></tr></thead>
          <tbody>${delayedTasks.map(d => `<tr><td>${esc(d.taskName)}</td><td>${esc(d.projectName)}</td><td>${d.baselineEnd || '-'}</td><td>${d.currentEnd || '-'}</td><td style="color:#dc2626;font-weight:600">+${d.delayDays}d</td></tr>`).join('')}</tbody>
        </table>` : '<p>No task delays.</p>'}

        ${escalatedRisks.length ? `
        <h4>Escalated Risks</h4>
        <table class="impact-table">
          <thead><tr><th>Risk</th><th>Project</th><th>Before</th><th>After</th></tr></thead>
          <tbody>${escalatedRisks.map(r => `<tr><td>${esc(r.riskName)}</td><td>${esc(r.projectName)}</td><td>${r.baselineLevel}</td><td style="color:#dc2626;font-weight:600">${r.currentLevel}</td></tr>`).join('')}</tbody>
        </table>` : ''}

        ${newOverloads.length ? `
        <h4>New Resource Overloads</h4>
        <table class="impact-table">
          <thead><tr><th>Resource</th><th>Baseline Peak</th><th>Current Peak</th><th>Sources</th></tr></thead>
          <tbody>${newOverloads.map(r => `<tr><td>${esc(r.resourceName)}</td><td>${r.baselinePeakLoad}%</td><td style="color:#dc2626">${r.currentPeakLoad}%</td><td>${r.overloadSources.slice(0, 3).map(s => esc(s.taskName)).join(', ')}</td></tr>`).join('')}</tbody>
        </table>` : ''}

        <h4>Critical Path</h4>
        <p>Baseline: ${impact.criticalPathChanges.baselineCritical.length} tasks | Current: ${impact.criticalPathChanges.currentCritical.length} tasks</p>
        <p>Newly critical: ${impact.criticalPathChanges.added.length} | No longer critical: ${impact.criticalPathChanges.removed.length}</p>
      </div>
    `;

    document.dispatchEvent(new CustomEvent('app:show-modal', { detail: { content } }));
  }

  // -- Export functions ----------------------------------------------------

  _exportHTML() {
    try {
      const snapshot = this.store.getSnapshot();
      const html = this.riskEngine.exportReportHTML(null, snapshot);
      this._downloadBlob(html, 'risk-report.html', 'text/html');
    } catch (err) {
      console.error('Export HTML failed:', err);
    }
  }

  _exportCSV() {
    try {
      const snapshot = this.store.getSnapshot();
      const report = this.riskEngine.generateReport(null, snapshot);
      const rows = [['Name', 'Probability', 'Impact', 'Level', 'Status', 'Owner']];
      for (const r of (report.topRisks || [])) {
        rows.push([r.name, r.probability, r.impact, r.level, r.status || '', r.owner || '']);
      }
      const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      this._downloadBlob(csv, 'risk-report.csv', 'text/csv');
    } catch (err) {
      console.error('Export CSV failed:', err);
    }
  }

  _exportBaselines() {
    if (!this.baselineManager) return;
    const json = this.baselineManager.exportAllBaselines();
    this._downloadBlob(json, `baselines-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Baselines exported', type: 'success' } }));
  }

  _importBaselines() {
    if (!this.baselineManager) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = this.baselineManager.importBaselines(reader.result);
        this.baselineManager.save();
        if (result.success) {
          document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: `Imported ${result.imported} baseline(s)`, type: 'success' } }));
        }
        if (result.errors.length) {
          for (const err of result.errors) {
            document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: err, type: 'error' } }));
          }
        }
        this._renderBaselineMenu();
      };
      reader.readAsText(file);
    });
    input.click();
  }

  _downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -- Sample data ---------------------------------------------------------

  _downloadSampleData() {
    const sample = {
      projects: [
        { id: 'p1', name: 'Website Redesign', department: 'Engineering', projectManager: 'Alice', status: 'active', startDate: '2026-01-15', endDate: '2026-06-30', color: '#3b82f6' },
      ],
      tasks: [
        { id: 't1', projectId: 'p1', name: 'Design Mockups', dependencies: [], assignee: 'Bob', plannedStart: '2026-01-15', plannedEnd: '2026-02-15', status: 'completed', progress: 100, priority: 'high' },
        { id: 't2', projectId: 'p1', name: 'Frontend Development', dependencies: ['t1'], assignee: 'Carol', plannedStart: '2026-02-16', plannedEnd: '2026-04-30', status: 'in-progress', progress: 45, priority: 'high' },
        { id: 't3', projectId: 'p1', name: 'QA Testing', dependencies: ['t2'], assignee: 'Dave', plannedStart: '2026-05-01', plannedEnd: '2026-05-30', status: 'not-started', progress: 0, priority: 'medium', isMilestone: true, milestoneDate: '2026-05-30' },
      ],
    };
    this._downloadBlob(JSON.stringify(sample, null, 2), 'sample-data.json', 'application/json');
  }
}
