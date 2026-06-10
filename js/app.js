/**
 * PMO Dashboard — Application Controller
 *
 * Wires together the store, engines, and view components into a cohesive
 * single-page application.  Handles CSV import, view switching, undo/redo,
 * auto-save, keyboard shortcuts, and sample-data generation.
 *
 * @module app
 */

import { Store }            from './core/store.js';
import { CSVParser }        from './core/csv-parser.js';
import { DependencyEngine } from './core/dependency-engine.js';
import { ResourceEngine }   from './engine/resource-engine.js';
import { RiskEngine }       from './engine/risk-engine.js';
import { HistoryManager }   from './core/history-manager.js';
import { GanttChart }       from './views/gantt-chart.js';
import { MilestoneView }    from './views/milestone-view.js';
import { ResourceView }     from './views/resource-view.js';
import { DelayHeatmap }     from './views/delay-heatmap.js';
import { RiskMatrix }       from './views/risk-matrix.js';
import { FilterBar }        from './views/filter-bar.js';
import { Toolbar }          from './views/toolbar.js';

/* -------------------------------------------------------------------------- */
/*  Utility helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Simple debounce — returns a wrapper that delays invocation until `wait` ms
 * have elapsed since the last call.
 */
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Generate a short unique id. */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* -------------------------------------------------------------------------- */
/*  View name → display label map                                             */
/* -------------------------------------------------------------------------- */

const VIEW_LABELS = {
  gantt:      '甘特图',
  milestone:  '里程碑',
  resource:   '资源',
  heatmap:    '延迟热力图',
  risk:       '风险矩阵',
};

/* ========================================================================== */
/*  App class                                                                 */
/* ========================================================================== */

class App {
  constructor() {
    // Core services
    this.store            = new Store();
    this.csvParser        = new CSVParser();
    this.dependencyEngine = new DependencyEngine(this.store);
    this.resourceEngine   = new ResourceEngine(this.store);
    this.riskEngine       = new RiskEngine(this.store);
    this.historyManager   = new HistoryManager(this.store);

    // UI state
    this.currentView = null;   // active view instance
    this.viewName    = 'gantt';
    this.views       = {};     // cache of instantiated views
    this.worker      = null;   // Web Worker handle
    this.workerReqId = 0;      // monotonic id for worker promise map
    this.workerPending = new Map(); // id → { resolve, reject }

    this.toolbar   = null;
    this.filterBar = null;

    // Debounced helpers (bound once)
    this._debouncedRender = debounce(() => this._renderCurrentView(), 120);
    this._debouncedSave   = debounce(() => this.saveState(), 2000);
  }

  /* ---------------------------------------------------------------------- */
  /*  Initialization                                                        */
  /* ---------------------------------------------------------------------- */

  /** Bootstrap the entire application. */
  init() {
    this.initWorker();

    // Persistent chrome — toolbar & filter bar
    this.toolbar = new Toolbar(
      document.getElementById('toolbar'),
      this.store,
      this.historyManager,
      this.riskEngine,
    );
    this.toolbar.render();

    this.filterBar = new FilterBar(
      document.getElementById('filter-bar'),
      this.store,
    );
    this.filterBar.render();

    this.setupEventListeners();

    // React to every store mutation
    this.store.subscribe((event) => this.onStoreChange(event));

    // Restore persisted state (if any)
    this.loadState();

    // Auto-save pipeline
    this.setupAutoSave();

    // Seed sample data when the store is empty
    if (this.store.state.projects.size === 0) {
      this.loadSampleData();
    }

    // Render the default view
    this.switchView('gantt');
    this.updateStatusBar();
  }

  /* ---------------------------------------------------------------------- */
  /*  1. Web Worker                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a Web Worker for heavy computations (critical-path, Monte-Carlo).
   * Communication uses a promise-based request/response pattern keyed by
   * monotonic request ids.
   */
  initWorker() {
    try {
      this.worker = new Worker('js/engine/worker.js', { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, result, error, progress } = e.data;
        const pending = this.workerPending.get(id);
        if (!pending) return;

        // Progress messages carry a percentage but are not final results —
        // don't resolve/delete the pending promise for them.
        if (progress !== undefined) return;

        this.workerPending.delete(id);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(result);
        }
      };
      this.worker.onerror = (err) => {
        console.warn('[Worker] error:', err);
      };
    } catch (err) {
      console.warn('[App] Web Worker unavailable, falling back to main thread.', err);
      this.worker = null;
    }
  }

  /**
   * Send a message to the worker and return a promise that resolves with the
   * result.  Falls back to a resolved promise when no worker is available.
   *
   * Includes the current store version so that stale results (computed
   * against a state that has since been undone/redone) can be detected
   * and discarded by the caller.
   */
  workerRequest(type, payload) {
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.workerReqId;
    const sentVersion = this.store.state.version;
    return new Promise((resolve, reject) => {
      this.workerPending.set(id, {
        resolve: (result) => {
          // Discard results if the store has been restored/changed since request
          if (this.store.state.version !== sentVersion) {
            resolve(null); // silently discard stale result
          } else {
            resolve(result);
          }
        },
        reject,
      });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  2. Event listeners                                                    */
  /* ---------------------------------------------------------------------- */

  setupEventListeners() {
    // CSV file picker
    const csvInput = document.getElementById('csv-input');
    csvInput.addEventListener('change', (e) => {
      if (e.target.files.length) this.handleCSVImport(e.target.files);
      e.target.value = ''; // allow re-selecting the same file
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z') { e.preventDefault(); this.historyManager.undo(); }
      if (ctrl && e.key === 'y') { e.preventDefault(); this.historyManager.redo(); }
      if (ctrl && e.key === 's') { e.preventDefault(); this.saveState(); this.showToast('已保存', 'success'); }
      if (ctrl && e.key === 'i') { e.preventDefault(); csvInput.click(); }
    });

    // Debounced resize
    window.addEventListener('resize', debounce(() => this._renderCurrentView(), 200));

    // Save before leaving
    window.addEventListener('beforeunload', () => this.saveState());

    // Close modal on overlay click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') this.closeModal();
    });

    // Custom toolbar events (dispatched by Toolbar component)
    document.addEventListener('app:import',      () => csvInput.click());
    document.addEventListener('app:export-csv',   () => this._exportCSV());
    document.addEventListener('app:export-report',() => this.exportRiskReport());
    document.addEventListener('app:undo',         () => this.historyManager.undo());
    document.addEventListener('app:redo',         () => this.historyManager.redo());
    document.addEventListener('app:save-scenario',() => { this.saveState(); this.showToast('场景已保存', 'success'); });
    document.addEventListener('app:switch-view',  (e) => this.switchView(e.detail.view));
    document.addEventListener('app:toggle-filter',() => this._toggleFilterBar());
  }

  /* ---------------------------------------------------------------------- */
  /*  3. CSV import                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Read one or more CSV files, parse them, validate for issues, merge into
   * the store, and push an undo snapshot.
   *
   * The pre-import state is captured via checkpoint() BEFORE any mutations
   * so that undo always reverts to the exact pre-import state — including
   * task dependencies AND resource allocations together.
   */
  async handleCSVImport(files) {
    // Capture a checkpoint of the current state BEFORE importing.
    // This ensures undo will atomically revert all four collections
    // (projects, tasks, risks, resources) together.
    this.historyManager.checkpoint('导入前状态');

    const results = [];
    const allWarnings = [];
    const allErrors = [];

    for (const file of files) {
      try {
        const text = await this._readFile(file);
        const data = this.csvParser.parse(text);

        // Validate before merging — detect cycles, dangling refs, overload
        const validation = CSVParser.validateImportData(data, this.store);
        allWarnings.push(...validation.warnings);
        allErrors.push(...validation.errors);

        // Import even if warnings exist (errors are non-blocking warnings
        // in this context — user can undo if needed)
        this.store.importData(data);

        const rowCount = (data.projects?.length ?? 0) +
                         (data.tasks?.length ?? 0) +
                         (data.risks?.length ?? 0) +
                         (data.resources?.length ?? 0);
        results.push({ name: file.name, rows: rowCount, ok: true });
      } catch (err) {
        results.push({ name: file.name, error: err.message, ok: false });
      }
    }

    // Push post-import state as undo checkpoint
    this.historyManager.push('CSV 导入');

    // Show validation errors/warnings
    if (allErrors.length > 0) {
      for (const err of allErrors) {
        this.showToast(err, 'error', 8000);
      }
    }
    if (allWarnings.length > 0) {
      const shown = allWarnings.slice(0, 5);
      for (const warn of shown) {
        this.showToast(warn, 'warning', 6000);
      }
      if (allWarnings.length > 5) {
        this.showToast(`还有 ${allWarnings.length - 5} 条验证警告`, 'warning', 4000);
      }
    }

    // Summarise import results
    const ok   = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);
    if (ok.length) {
      const totalRows = ok.reduce((s, r) => s + r.rows, 0);
      this.showToast(`成功导入 ${ok.length} 个文件，共 ${totalRows} 条记录`, 'success');
    }
    fail.forEach((r) => {
      this.showToast(`${r.name} 导入失败: ${r.error}`, 'error', 6000);
    });

    // Run post-import circular dependency check against the full store
    const cycles = this.dependencyEngine.detectCircularDependencies?.();
    if (cycles?.length) {
      this.showToast(`导入后检测到 ${cycles.length} 个循环依赖，可撤销导入`, 'error', 8000);
    }
  }

  /** Promise wrapper around FileReader. */
  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  4. View switching                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Tear down the active view (if any), instantiate or reuse the target view,
   * render it into the view-container, and update store state.
   */
  switchView(viewName) {
    if (!VIEW_LABELS[viewName]) {
      console.warn(`[App] Unknown view: ${viewName}`);
      return;
    }

    // Destroy current view and remove from cache (destroyed views can't be reused)
    if (this.currentView?.destroy) {
      this.currentView.destroy();
      delete this.views[this.viewName];
    }

    this.viewName = viewName;

    // Build or reuse view instance
    if (!this.views[viewName]) {
      const container = document.getElementById('view-container');
      const ViewClass = {
        gantt:     GanttChart,
        milestone: MilestoneView,
        resource:  ResourceView,
        heatmap:   DelayHeatmap,
        risk:      RiskMatrix,
      }[viewName];

      this.views[viewName] = new ViewClass(container, this.store, {
        dependencyEngine: this.dependencyEngine,
        resourceEngine:   this.resourceEngine,
        riskEngine:       this.riskEngine,
        workerRequest:    (t, p) => this.workerRequest(t, p),
        showToast:        (m, t) => this.showToast(m, t),
        showModal:        (c)    => this.showModal(c),
      });
    }

    this.currentView = this.views[viewName];
    this._renderCurrentView();

    // Sync store (use reactive proxy setter)
    this.store.state.view = viewName;

    this.updateStatusBar();
  }

  /** Ask the current view to (re)render. */
  _renderCurrentView() {
    if (this.currentView?.render) {
      this.currentView.render();
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  5. Store change handler                                               */
  /* ---------------------------------------------------------------------- */

  onStoreChange(event) {
    this.updateStatusBar();

    // After a full state restore (undo/redo/scenario-load), force an
    // immediate re-render instead of debouncing — the entire state has
    // changed and engine caches have already been invalidated by the
    // 'restore' event.
    if (event?.type === 'restore') {
      this._renderCurrentView();
      return;
    }

    this._debouncedRender();

    // Check for circular dependencies whenever task deps change
    if (event?.type === 'task' || event?.type === 'batch') {
      const cycles = this.dependencyEngine.detectCircularDependencies?.();
      if (cycles?.length) {
        this.showToast(`检测到 ${cycles.length} 个循环依赖`, 'warning', 5000);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  6. Persistence (localStorage)                                         */
  /* ---------------------------------------------------------------------- */

  /** Restore store state from localStorage. */
  loadState() {
    try {
      const raw = localStorage.getItem('pmo-dashboard-state');
      if (!raw) return;
      const data = JSON.parse(raw);

      // Rehydrate using store CRUD methods inside a batch to avoid
      // excessive re-renders.  The proxy setter only allows 'view' and
      // 'selectedProjectId', so direct Map assignment is not possible.
      this.store.batch(() => {
        for (const p of (data.projects || [])) {
          if (!this.store.state.projects.has(p.id)) this.store.addProject(p);
        }
        for (const t of (data.tasks || [])) {
          if (!this.store.state.tasks.has(t.id)) this.store.addTask(t);
        }
        for (const r of (data.risks || [])) {
          if (!this.store.state.risks.has(r.id)) this.store.addRisk(r);
        }
        for (const r of (data.resources || [])) {
          if (!this.store.state.resources.has(r.id)) this.store.addResource(r);
        }
      });

      if (data.view) {
        this.viewName = data.view;
      }
    } catch (err) {
      console.warn('[App] Failed to load saved state:', err);
    }
  }

  /** Serialize store state and write to localStorage using an atomic snapshot. */
  saveState() {
    try {
      const snapshot = this.store.getSnapshot();
      const payload = {
        projects:  snapshot.projects  || [],
        tasks:     snapshot.tasks     || [],
        risks:     snapshot.risks     || [],
        resources: snapshot.resources || [],
        view:      this.viewName,
        savedAt:   new Date().toISOString(),
      };
      localStorage.setItem('pmo-dashboard-state', JSON.stringify(payload));
      this._lastSaveTime = new Date();
    } catch (err) {
      console.warn('[App] Failed to save state:', err);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  7. Sample data generator                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Generate realistic demo data: 3 projects, ~19 tasks, 6 resources,
   * 10 risks, cross-project + circular dependency examples, and a couple of
   * overloaded resources.
   */
  loadSampleData() {
    const today = new Date();
    const d = (offset) => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() + offset);
      return dt.toISOString().slice(0, 10);
    };

    // -- Projects (using Store schema: name, department, projectManager, status, startDate, endDate, color)
    this.store.addProject({ id: 'proj-alpha', name: 'Project Alpha — 软件开发', department: 'Engineering', projectManager: '张明', status: 'active',  startDate: d(-30), endDate: d(60),  color: '#3b82f6' });
    this.store.addProject({ id: 'proj-beta',  name: 'Project Beta — 基础设施迁移', department: 'IT',        projectManager: '李华', status: 'active',  startDate: d(-15), endDate: d(75),  color: '#e67e22' });
    this.store.addProject({ id: 'proj-gamma', name: 'Project Gamma — 营销活动', department: 'Marketing',  projectManager: '王芳', status: 'planning', startDate: d(5),   endDate: d(90),  color: '#22c55e' });

    // -- Tasks (using Store schema: plannedStart/plannedEnd, assignee, dependencies[], isMilestone, crossProjectDeps)
    // Project Alpha — 8 tasks
    this.store.addTask({ id: 'a1', projectId: 'proj-alpha', name: '需求分析',         plannedStart: d(-30), plannedEnd: d(-20), progress: 100, status: 'completed',  assignee: '赵敏', dependencies: [], estimatedDays: 10, priority: 4 });
    this.store.addTask({ id: 'a2', projectId: 'proj-alpha', name: 'UI 设计',          plannedStart: d(-22), plannedEnd: d(-12), progress: 100, status: 'completed',  assignee: '孙磊', dependencies: ['a1'], estimatedDays: 10, priority: 4 });
    this.store.addTask({ id: 'a3', projectId: 'proj-alpha', name: '前端框架搭建',      plannedStart: d(-14), plannedEnd: d(-4),  progress: 80,  status: 'in-progress', assignee: '张伟', dependencies: ['a2'], estimatedDays: 10, priority: 3 });
    this.store.addTask({ id: 'a4', projectId: 'proj-alpha', name: '后端 API 开发',     plannedStart: d(-12), plannedEnd: d(5),   progress: 60,  status: 'in-progress', assignee: '陈静', dependencies: ['a5'], estimatedDays: 17, priority: 3 });
    this.store.addTask({ id: 'a5', projectId: 'proj-alpha', name: '数据库设计',        plannedStart: d(-20), plannedEnd: d(-10), progress: 100, status: 'completed',  assignee: '陈静', dependencies: [], estimatedDays: 10, priority: 4 });
    this.store.addTask({ id: 'a6', projectId: 'proj-alpha', name: '集成测试',          plannedStart: d(6),   plannedEnd: d(20),  progress: 0,   status: 'not-started', assignee: '张伟', dependencies: ['a3', 'a4'], estimatedDays: 14, priority: 3 });
    this.store.addTask({ id: 'a7', projectId: 'proj-alpha', name: '性能优化',          plannedStart: d(21),  plannedEnd: d(35),  progress: 0,   status: 'not-started', assignee: '张伟', dependencies: ['a6'], crossProjectDeps: [{ projectId: 'proj-gamma', taskId: 'g3' }], estimatedDays: 14, priority: 2 });
    this.store.addTask({ id: 'a8', projectId: 'proj-alpha', name: '上线部署',          plannedStart: d(36),  plannedEnd: d(42),  progress: 0,   status: 'not-started', assignee: '刘洋', dependencies: ['a7'], isMilestone: true, milestoneDate: d(42), estimatedDays: 6, priority: 5 });

    // Project Beta — 6 tasks
    this.store.addTask({ id: 'b1', projectId: 'proj-beta', name: '现状评估',          plannedStart: d(-15), plannedEnd: d(-8),  progress: 100, status: 'completed',  assignee: '刘洋', dependencies: [], estimatedDays: 7, priority: 4 });
    this.store.addTask({ id: 'b2', projectId: 'proj-beta', name: '迁移方案设计',       plannedStart: d(-10), plannedEnd: d(-2),  progress: 90,  status: 'in-progress', assignee: '刘洋', dependencies: ['b1'], estimatedDays: 8, priority: 4 });
    this.store.addTask({ id: 'b3', projectId: 'proj-beta', name: '测试环境搭建',       plannedStart: d(-3),  plannedEnd: d(8),   progress: 40,  status: 'in-progress', assignee: '刘洋', dependencies: ['b2'], estimatedDays: 11, priority: 3 });
    this.store.addTask({ id: 'b4', projectId: 'proj-beta', name: '数据迁移',          plannedStart: d(9),   plannedEnd: d(25),  progress: 0,   status: 'not-started', assignee: '陈静', dependencies: ['b3'], crossProjectDeps: [{ projectId: 'proj-alpha', taskId: 'a4' }], estimatedDays: 16, priority: 3 });
    this.store.addTask({ id: 'b5', projectId: 'proj-beta', name: '系统验证',          plannedStart: d(26),  plannedEnd: d(45),  progress: 0,   status: 'not-started', assignee: '赵敏', dependencies: ['b4'], estimatedDays: 19, priority: 3 });
    this.store.addTask({ id: 'b6', projectId: 'proj-beta', name: '生产切换',          plannedStart: d(46),  plannedEnd: d(55),  progress: 0,   status: 'not-started', assignee: '刘洋', dependencies: ['b5'], isMilestone: true, milestoneDate: d(55), estimatedDays: 9, priority: 5 });

    // Project Gamma — 5 tasks
    this.store.addTask({ id: 'g1', projectId: 'proj-gamma', name: '市场调研',         plannedStart: d(5),   plannedEnd: d(18),  progress: 20,  status: 'in-progress', assignee: '周涛', dependencies: [], estimatedDays: 13, priority: 3 });
    this.store.addTask({ id: 'g2', projectId: 'proj-gamma', name: '内容策划',         plannedStart: d(19),  plannedEnd: d(32),  progress: 0,   status: 'not-started', assignee: '孙磊', dependencies: ['g1'], estimatedDays: 13, priority: 3 });
    this.store.addTask({ id: 'g3', projectId: 'proj-gamma', name: '素材制作',         plannedStart: d(33),  plannedEnd: d(50),  progress: 0,   status: 'not-started', assignee: '孙磊', dependencies: ['g2'], crossProjectDeps: [{ projectId: 'proj-alpha', taskId: 'a7' }], estimatedDays: 17, priority: 3 });
    this.store.addTask({ id: 'g4', projectId: 'proj-gamma', name: '渠道投放',         plannedStart: d(51),  plannedEnd: d(70),  progress: 0,   status: 'not-started', assignee: '周涛', dependencies: ['g3'], estimatedDays: 19, priority: 3 });
    this.store.addTask({ id: 'g5', projectId: 'proj-gamma', name: '效果复盘',         plannedStart: d(71),  plannedEnd: d(85),  progress: 0,   status: 'not-started', assignee: '赵敏', dependencies: ['g4'], isMilestone: true, milestoneDate: d(85), estimatedDays: 14, priority: 4 });

    // -- Resources (using Store schema: name, department, role, tasks:[{taskId,projectId,allocation}], maxCapacity)
    this.store.addResource({ id: 'res-1', name: '张伟',  department: 'Engineering', role: '前端工程师',   tasks: [{ taskId: 'a3', projectId: 'proj-alpha', allocation: 80 }, { taskId: 'a6', projectId: 'proj-alpha', allocation: 50 }, { taskId: 'a7', projectId: 'proj-alpha', allocation: 80 }], maxCapacity: 100 });
    this.store.addResource({ id: 'res-2', name: '陈静',  department: 'Engineering', role: '后端工程师',   tasks: [{ taskId: 'a4', projectId: 'proj-alpha', allocation: 80 }, { taskId: 'a5', projectId: 'proj-alpha', allocation: 60 }, { taskId: 'b4', projectId: 'proj-beta', allocation: 60 }], maxCapacity: 100 });
    this.store.addResource({ id: 'res-3', name: '刘洋',  department: 'IT',          role: 'DevOps 工程师', tasks: [{ taskId: 'a8', projectId: 'proj-alpha', allocation: 40 }, { taskId: 'b1', projectId: 'proj-beta', allocation: 60 }, { taskId: 'b2', projectId: 'proj-beta', allocation: 60 }, { taskId: 'b3', projectId: 'proj-beta', allocation: 80 }, { taskId: 'b6', projectId: 'proj-beta', allocation: 60 }], maxCapacity: 100 });
    this.store.addResource({ id: 'res-4', name: '赵敏',  department: 'Management',  role: '项目经理',     tasks: [{ taskId: 'a1', projectId: 'proj-alpha', allocation: 40 }, { taskId: 'b5', projectId: 'proj-beta', allocation: 50 }, { taskId: 'g5', projectId: 'proj-gamma', allocation: 40 }], maxCapacity: 100 });
    this.store.addResource({ id: 'res-5', name: '孙磊',  department: 'Design',      role: 'UI/UX 设计师', tasks: [{ taskId: 'a2', projectId: 'proj-alpha', allocation: 80 }, { taskId: 'g2', projectId: 'proj-gamma', allocation: 60 }, { taskId: 'g3', projectId: 'proj-gamma', allocation: 60 }], maxCapacity: 100 });
    this.store.addResource({ id: 'res-6', name: '周涛',  department: 'Analytics',   role: '数据分析师',   tasks: [{ taskId: 'b4', projectId: 'proj-beta', allocation: 40 }, { taskId: 'g1', projectId: 'proj-gamma', allocation: 60 }, { taskId: 'g4', projectId: 'proj-gamma', allocation: 60 }], maxCapacity: 100 });

    // -- Risks (using Store schema: name, projectId, taskId, probability, impact, category, mitigation, status, owner)
    this.store.addRisk({ id: 'r1',  projectId: 'proj-alpha', taskId: 'a3',  name: '前端技术栈升级风险', probability: 3, impact: 4, category: '技术', mitigation: '提前进行 POC 验证', status: 'open', owner: '张伟' });
    this.store.addRisk({ id: 'r2',  projectId: 'proj-alpha', taskId: '',    name: '关键人员离职风险',   probability: 2, impact: 5, category: '资源', mitigation: '知识转移与文档化', status: 'open', owner: '赵敏' });
    this.store.addRisk({ id: 'r3',  projectId: 'proj-alpha', taskId: '',    name: '需求变更频繁',      probability: 4, impact: 3, category: '范围', mitigation: '严格变更控制流程', status: 'open', owner: '赵敏' });
    this.store.addRisk({ id: 'r4',  projectId: 'proj-beta',  taskId: 'b4',  name: '数据丢失风险',      probability: 2, impact: 5, category: '技术', mitigation: '全量备份 + 增量校验', status: 'mitigating', owner: '刘洋' });
    this.store.addRisk({ id: 'r5',  projectId: 'proj-beta',  taskId: 'b4',  name: '迁移窗口超时',      probability: 3, impact: 4, category: '进度', mitigation: '分批迁移 + 回滚方案', status: 'open', owner: '刘洋' });
    this.store.addRisk({ id: 'r6',  projectId: 'proj-beta',  taskId: '',    name: '兼容性问题',        probability: 4, impact: 3, category: '技术', mitigation: '全面的兼容性测试矩阵', status: 'open', owner: '陈静' });
    this.store.addRisk({ id: 'r7',  projectId: 'proj-gamma', taskId: '',    name: '预算超支',          probability: 3, impact: 3, category: '成本', mitigation: '每周预算跟踪报告', status: 'monitoring', owner: '赵敏' });
    this.store.addRisk({ id: 'r8',  projectId: 'proj-gamma', taskId: 'g3',  name: '素材交付延迟',       probability: 4, impact: 4, category: '进度', mitigation: '提前两周启动素材制作', status: 'open', owner: '孙磊' });
    this.store.addRisk({ id: 'r9',  projectId: 'proj-gamma', taskId: 'g4',  name: '渠道效果不达预期',    probability: 3, impact: 2, category: '市场', mitigation: 'A/B 测试 + 快速迭代', status: 'open', owner: '周涛' });
    this.store.addRisk({ id: 'r10', projectId: 'proj-alpha', taskId: '',    name: '安全漏洞',          probability: 2, impact: 5, category: '安全', mitigation: 'SAST/DAST 集成到 CI', status: 'open', owner: '刘洋' });

    // Push initial history snapshot
    this.historyManager.push('加载示例数据');
  }

  /* ---------------------------------------------------------------------- */
  /*  8. Auto-save                                                          */
  /* ---------------------------------------------------------------------- */

  /** Wire auto-save so every store change triggers a debounced persist. */
  setupAutoSave() {
    this.store.subscribe(() => this._debouncedSave());
  }

  /* ---------------------------------------------------------------------- */
  /*  9. Export risk report                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Ask the risk engine for an HTML report, then open it in a new browser
   * window (or trigger a download).
   *
   * Takes an atomic snapshot of the store first so that the report
   * reflects a single consistent point-in-time state.
   */
  async exportRiskReport() {
    try {
      // Take an atomic snapshot to ensure the report and any supplementary
      // data (resource conflicts, dependency issues) are from the same state
      const snapshot = this.store.getSnapshot();
      const version = snapshot.version;

      // Gather supplementary data from engines (all based on current store state)
      const cycles = this.dependencyEngine.detectCircularDependencies?.() || [];
      const crossProjectDeps = this.dependencyEngine.getCrossProjectDeps?.() || [];
      const resourceOverloads = this.resourceEngine.findOverloadedResources?.() || [];

      // Check risk level consistency
      const riskLevelChanges = [];
      for (const r of snapshot.risks) {
        const expected = (r.probability || 3) * (r.impact || 3);
        let expectedLevel;
        if (expected >= 20) expectedLevel = 'critical';
        else if (expected >= 12) expectedLevel = 'high';
        else if (expected >= 6) expectedLevel = 'medium';
        else expectedLevel = 'low';
        if (r.level && r.level !== expectedLevel) {
          riskLevelChanges.push(`"${r.name}": stated ${r.level}, computed ${expectedLevel} (P${r.probability}×I${r.impact}=${expected})`);
        }
      }

      const extras = {
        cycles: cycles.length > 0 ? cycles : null,
        crossProjectDeps: crossProjectDeps.length > 0 ? crossProjectDeps : null,
        resourceOverloads: resourceOverloads.length > 0 ? resourceOverloads : null,
        riskLevelChanges: riskLevelChanges.length > 0 ? riskLevelChanges : null,
      };

      const html = this.riskEngine.exportReportHTML?.(null, extras);
      if (html) {
        // Verify the store hasn't changed since we started generating
        if (this.store.state.version !== version) {
          this.showToast('状态已变更，请重新导出', 'warning');
          return;
        }

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const win  = window.open(url, '_blank');
        if (!win) {
          const a  = document.createElement('a');
          a.href     = url;
          a.download = 'risk-report.html';
          a.click();
        }
        this.showToast('风险报告已导出', 'success');
      } else {
        this.showToast('风险引擎未返回报告内容', 'warning');
      }
    } catch (err) {
      this.showToast(`导出失败: ${err.message}`, 'error');
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  10. Status bar                                                        */
  /* ---------------------------------------------------------------------- */

  updateStatusBar() {
    const statusText = document.getElementById('status-text');
    const statusStats = document.getElementById('status-stats');

    const viewLabel = VIEW_LABELS[this.viewName] ?? this.viewName;
    statusText.textContent = `${viewLabel} — 就绪`;

    // Aggregate stats
    const stats = this.store.getStats?.() ?? {};
    const projectCount = stats.totalProjects ?? this.store.state.projects.size;
    const taskCount    = stats.totalTasks    ?? this.store.state.tasks.size;
    const riskCount    = this.store.state.risks.size;

    const saveLabel = this._lastSaveTime
      ? `上次保存: ${this._lastSaveTime.toLocaleTimeString('zh-CN')}`
      : '未保存';

    statusStats.innerHTML =
      `<span>项目: ${projectCount}</span>` +
      `<span>任务: ${taskCount}</span>` +
      `<span>风险: ${riskCount}</span>` +
      `<span>${saveLabel}</span>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  11. Toast notifications                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Display a transient notification that slides in from the top-right.
   *
   * @param {string} message  — text to display
   * @param {'success'|'warning'|'error'|'info'} type
   * @param {number} duration — ms before auto-dismiss (default 3500)
   */
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');

    // Icon map (simple unicode for portability)
    const icons = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon">${icons[type] ?? icons.info}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close" aria-label="关闭">&times;</button>
    `;

    // Close button
    el.querySelector('.toast-close').addEventListener('click', () => dismiss());

    container.appendChild(el);

    const dismiss = () => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };

    // Auto-dismiss
    setTimeout(dismiss, duration);
  }

  /* ---------------------------------------------------------------------- */
  /*  12. Modal                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Populate and reveal the modal overlay.
   *
   * @param {string|HTMLElement} content — HTML string or DOM node
   */
  showModal(content) {
    const overlay = document.getElementById('modal-overlay');
    const box     = document.getElementById('modal-content');

    if (typeof content === 'string') {
      box.innerHTML = content;
    } else {
      box.innerHTML = '';
      box.appendChild(content);
    }

    // Ensure close button behaviour
    const closeBtn = box.querySelector('.modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeModal(), { once: true });
    }

    overlay.classList.remove('hidden');
  }

  /** Hide the modal overlay. */
  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  /* ---------------------------------------------------------------------- */
  /*  Private helpers                                                       */
  /* ---------------------------------------------------------------------- */

  /** Toggle the filter bar collapsed state. */
  _toggleFilterBar() {
    const bar     = document.getElementById('filter-bar');
    const content = document.getElementById('main-content');
    bar.classList.toggle('collapsed');
    content.classList.toggle('filter-collapsed');
  }

  /** Export current store data as a CSV download using an atomic snapshot. */
  _exportCSV() {
    try {
      // Use getSnapshot() for a consistent point-in-time export
      const snapshot = this.store.getSnapshot();
      const data = {
        projects: snapshot.projects,
        tasks: snapshot.tasks,
        risks: snapshot.risks,
        resources: snapshot.resources,
      };
      const csv = CSVParser.exportData(data);
      if (!csv) { this.showToast('CSV 导出不可用', 'warning'); return; }
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `pmo-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('CSV 导出完成', 'success');
    } catch (err) {
      this.showToast(`导出失败: ${err.message}`, 'error');
    }
  }
}

/* ========================================================================== */
/*  Bootstrap                                                                 */
/* ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window.app = app; // expose for debugging in dev-tools
});
