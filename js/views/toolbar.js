// Toolbar - Top toolbar with view switcher, undo/redo, scenario management,
// import/export, keyboard shortcuts, and live stats display.

const VIEWS = [
  { id: 'gantt', label: 'Gantt', icon: '\u25A4' },
  { id: 'milestone', label: 'Milestones', icon: '\u25C6' },
  { id: 'resource', label: 'Resources', icon: '\u2630' },
  { id: 'heatmap', label: 'Heatmap', icon: '\u25A6' },
  { id: 'risk', label: 'Risk Matrix', icon: '\u26A0' },
];

/**
 * Toolbar provides the top-level action bar with view switching tabs,
 * undo/redo controls, scenario management, CSV import, report export,
 * keyboard shortcuts, and live project/task statistics.
 */
export class Toolbar {
  constructor(container, store, historyManager, riskEngine) {
    this.container = container;
    this.store = store;
    this.history = historyManager;
    this.riskEngine = riskEngine;

    this._listeners = [];
    this._unsubscribe = null;
    this._scenarioMenuOpen = false;
    this._exportMenuOpen = false;

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderViewTabs();
    this._renderUndoRedo();
    this._renderStats();
    this._renderScenarioMenu();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
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
            <button class="toolbar-btn toolbar-btn-save-scenario" title="Save Scenario (Ctrl+S)">\u{1F4BE} Save Scenario</button>
            <button class="toolbar-btn toolbar-btn-load-scenario">\u25BC Load</button>
            <div class="toolbar-scenario-menu" style="display:none"></div>
          </div>
          <div class="toolbar-export">
            <button class="toolbar-btn toolbar-btn-export">\u{1F4E4} Export \u25BC</button>
            <div class="toolbar-export-menu" style="display:none">
              <button class="toolbar-menu-item" data-export="csv">Risk Report CSV</button>
              <button class="toolbar-menu-item" data-export="html">Risk Report HTML</button>
            </div>
          </div>
        </div>
        <div class="toolbar-right">
          <div class="toolbar-stats"></div>
          <a class="toolbar-sample-link" href="#" title="Download sample data">\u{1F4E5} Sample Data</a>
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

    // Import CSV — delegate to app.js which has the full import pipeline
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
      this._exportMenuOpen = false;
      this._els.exportMenu.style.display = 'none';
    });

    // Close menus on outside click
    this._listen(document, 'click', () => {
      if (this._scenarioMenuOpen) { this._scenarioMenuOpen = false; this._renderScenarioMenu(); }
      if (this._exportMenuOpen) { this._exportMenuOpen = false; this._els.exportMenu.style.display = 'none'; }
    });

    // Sample data link
    this._listen(this._els.sampleLink, 'click', (e) => {
      e.preventDefault();
      this._downloadSampleData();
    });
  }

  // -- Keyboard shortcuts --------------------------------------------------
  // Note: keyboard shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+S) are handled by app.js
  // to avoid double-firing undo/redo/save actions.


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
      <span class="toolbar-stat toolbar-stat--danger"><span class="toolbar-stat-value">${criticalRisks}</span> Critical Risks</span>
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
