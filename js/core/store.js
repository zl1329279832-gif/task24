/**
 * store.js
 * Central reactive data store for the portfolio management dashboard.
 *
 * Uses Proxy-based observation so that any mutation to state properties
 * automatically notifies subscribers.  Data is held in Maps for O(1)
 * lookups, and all getters return deep-cloned snapshots so consumers
 * cannot accidentally mutate internal state.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep clone via structuredClone with JSON fallback for older runtimes */
function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

/** Generate a unique ID */
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

/** Convert a Map to a plain-object snapshot (deep-cloned values) */
function mapToObject(map) {
  const obj = {};
  for (const [k, v] of map) obj[k] = deepClone(v);
  return obj;
}

/** Restore a Map from a plain-object snapshot */
function objectToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) map.set(k, deepClone(v));
  }
  return map;
}

/** Day constant in milliseconds */
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Default filter state
// ---------------------------------------------------------------------------

const DEFAULT_FILTERS = Object.freeze({
  department: 'all',
  projectManager: 'all',
  status: 'all',
  riskLevel: 'all',
  search: '',
});

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

export class Store {
  constructor() {
    /** @type {Map<string, Project>} */
    this._projects = new Map();
    /** @type {Map<string, Task>} */
    this._tasks = new Map();
    /** @type {Map<string, Risk>} */
    this._risks = new Map();
    /** @type {Map<string, Resource>} */
    this._resources = new Map();

    /** Reactive filter state */
    this._filters = { ...DEFAULT_FILTERS };

    /** Currently selected project (null = all) */
    this._selectedProjectId = null;

    /** Current view */
    this._view = 'gantt';

    /** Saved scenarios */
    this._scenarios = [];

    /** Subscriber registry: each entry is { listener, typeFilter } */
    this._subscribers = [];

    /** Batch queue -- null when not batching */
    this._batchQueue = null;

    /**
     * Monotonically increasing version counter.
     * Incremented on every data-mutating operation so that engines and
     * the worker can detect stale results.
     */
    this._stateVersion = 0;

    /** Expose a reactive `state` proxy for convenient reads */
    this.state = this._buildStateProxy();
  }

  // -----------------------------------------------------------------------
  // State proxy -- gives consumers a convenient `store.state.xxx` interface
  // -----------------------------------------------------------------------

  _buildStateProxy() {
    const self = this;
    return new Proxy({}, {
      get(_target, prop) {
        switch (prop) {
          case 'projects':  return self._projects;
          case 'tasks':     return self._tasks;
          case 'risks':     return self._risks;
          case 'resources': return self._resources;
          case 'filters':   return { ...self._filters };
          case 'selectedProjectId': return self._selectedProjectId;
          case 'view':      return self._view;
          case 'scenarios': return [...self._scenarios];
          case 'version':   return self._stateVersion;
          default:          return undefined;
        }
      },
      set(_target, prop, value) {
        switch (prop) {
          case 'selectedProjectId':
            self._selectedProjectId = value;
            self._emit({ type: 'select', path: 'selectedProjectId', value });
            return true;
          case 'view':
            self._view = value;
            self._emit({ type: 'view', path: 'view', value });
            return true;
          default:
            return false;
        }
      },
    });
  }

  // -----------------------------------------------------------------------
  // Subscription system
  // -----------------------------------------------------------------------

  /**
   * Subscribe to state changes.
   * @param {Function} listener - receives { type, path, value }
   * @param {string}   [typeFilter] - optional: only receive events of this type
   * @returns {Function} unsubscribe function
   */
  subscribe(listener, typeFilter) {
    const entry = { listener, typeFilter: typeFilter || null };
    this._subscribers.push(entry);
    return () => {
      const idx = this._subscribers.indexOf(entry);
      if (idx !== -1) this._subscribers.splice(idx, 1);
    };
  }

  /** Emit an event to all matching subscribers (respects batching) */
  _emit(event) {
    if (this._batchQueue !== null) {
      this._batchQueue.push(event);
      return;
    }
    for (const { listener, typeFilter } of this._subscribers) {
      if (!typeFilter || typeFilter === event.type) {
        try { listener(event); } catch (e) { console.error('Store subscriber error:', e); }
      }
    }
  }

  /**
   * Batch multiple mutations into a single notification.
   * Subscribers receive one aggregated event at the end.
   */
  batch(fn) {
    const prev = this._batchQueue;
    this._batchQueue = [];
    try {
      fn();
    } finally {
      const events = this._batchQueue;
      this._batchQueue = prev;

      if (events.length > 0 && this._batchQueue === null) {
        // Emit a single 'batch' event containing all sub-events
        const batchEvent = { type: 'batch', path: null, value: events };
        for (const { listener, typeFilter } of this._subscribers) {
          if (!typeFilter || typeFilter === 'batch') {
            try { listener(batchEvent); } catch (e) { console.error('Store subscriber error:', e); }
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Project CRUD
  // -----------------------------------------------------------------------

  addProject(project) {
    const p = deepClone(project);
    if (!p.id) p.id = uid();
    p.name = p.name || 'Unnamed Project';
    p.department = p.department || '';
    p.projectManager = p.projectManager || '';
    p.status = p.status || 'active';
    p.startDate = p.startDate || null;
    p.endDate = p.endDate || null;
    p.color = p.color || '#4A90D9';
    this._projects.set(p.id, p);
    this._stateVersion++;
    this._emit({ type: 'project', path: 'add', value: deepClone(p) });
  }

  updateProject(id, changes) {
    const existing = this._projects.get(id);
    if (!existing) return;
    const merged = { ...existing, ...deepClone(changes), id }; // id is immutable
    this._projects.set(id, merged);
    this._stateVersion++;
    this._emit({ type: 'project', path: 'update', value: deepClone(merged) });
  }

  removeProject(id) {
    if (!this._projects.has(id)) return;
    const removed = this._projects.get(id);
    this._projects.delete(id);
    // Cascade: remove related tasks, risks
    for (const [tid, t] of this._tasks) {
      if (t.projectId === id) this._tasks.delete(tid);
    }
    for (const [rid, r] of this._risks) {
      if (r.projectId === id) this._risks.delete(r.id);
    }
    this._stateVersion++;
    this._emit({ type: 'project', path: 'remove', value: deepClone(removed) });
  }

  // -----------------------------------------------------------------------
  // Task CRUD
  // -----------------------------------------------------------------------

  addTask(task) {
    const t = deepClone(task);
    if (!t.id) t.id = uid();
    t.name = t.name || 'Unnamed Task';
    t.projectId = t.projectId || '';
    t.dependencies = t.dependencies || [];
    t.crossProjectDeps = t.crossProjectDeps || [];
    t.assignee = t.assignee || '';
    t.plannedStart = t.plannedStart || null;
    t.plannedEnd = t.plannedEnd || null;
    t.actualStart = t.actualStart || null;
    t.actualEnd = t.actualEnd || null;
    t.status = t.status || 'not-started';
    t.progress = t.progress ?? 0;
    t.isMilestone = t.isMilestone ?? false;
    t.milestoneDate = t.milestoneDate || null;
    t.estimatedDays = t.estimatedDays ?? 0;
    t.priority = t.priority ?? 3;
    this._tasks.set(t.id, t);
    this._stateVersion++;
    this._emit({ type: 'task', path: 'add', value: deepClone(t) });
  }

  updateTask(id, changes) {
    const existing = this._tasks.get(id);
    if (!existing) return;
    const merged = { ...existing, ...deepClone(changes), id };
    this._tasks.set(id, merged);
    this._stateVersion++;
    this._emit({ type: 'task', path: 'update', value: deepClone(merged) });
  }

  removeTask(id) {
    if (!this._tasks.has(id)) return;
    const removed = this._tasks.get(id);
    this._tasks.delete(id);
    // Remove this task from other tasks' dependency lists
    for (const [, t] of this._tasks) {
      if (t.dependencies.includes(id)) {
        t.dependencies = t.dependencies.filter(d => d !== id);
      }
    }
    // Cascade: remove related risks
    for (const [rid, r] of this._risks) {
      if (r.taskId === id) this._risks.delete(rid);
    }
    this._stateVersion++;
    this._emit({ type: 'task', path: 'remove', value: deepClone(removed) });
  }

  /**
   * Move a task to new start/end dates.  Emits a special 'move' event
   * that the DependencyEngine can listen to for propagation.
   */
  moveTask(id, newStart, newEnd) {
    const existing = this._tasks.get(id);
    if (!existing) return;
    const oldStart = existing.plannedStart;
    const oldEnd = existing.plannedEnd;
    existing.plannedStart = newStart
      ? (newStart instanceof Date ? newStart.toISOString().slice(0, 10) : newStart)
      : existing.plannedStart;
    existing.plannedEnd = newEnd
      ? (newEnd instanceof Date ? newEnd.toISOString().slice(0, 10) : newEnd)
      : existing.plannedEnd;
    this._tasks.set(id, existing);
    this._stateVersion++;
    this._emit({
      type: 'task',
      path: 'move',
      value: { id, oldStart, oldEnd, newStart: existing.plannedStart, newEnd: existing.plannedEnd },
    });
  }

  // -----------------------------------------------------------------------
  // Risk CRUD
  // -----------------------------------------------------------------------

  addRisk(risk) {
    const r = deepClone(risk);
    if (!r.id) r.id = uid();
    r.name = r.name || 'Unnamed Risk';
    r.projectId = r.projectId || '';
    r.taskId = r.taskId || '';
    r.probability = r.probability ?? 3;
    r.impact = r.impact ?? 3;
    r.level = r.level || this._autoRiskLevel(r.probability, r.impact);
    r.category = r.category || 'general';
    r.mitigation = r.mitigation || '';
    r.status = r.status || 'open';
    r.owner = r.owner || '';
    this._risks.set(r.id, r);
    this._stateVersion++;
    this._emit({ type: 'risk', path: 'add', value: deepClone(r) });
  }

  updateRisk(id, changes) {
    const existing = this._risks.get(id);
    if (!existing) return;
    const merged = { ...existing, ...deepClone(changes), id };
    // Recalculate level if probability or impact changed
    if (changes.probability !== undefined || changes.impact !== undefined) {
      merged.level = this._autoRiskLevel(merged.probability, merged.impact);
    }
    this._risks.set(id, merged);
    this._stateVersion++;
    this._emit({ type: 'risk', path: 'update', value: deepClone(merged) });
  }

  removeRisk(id) {
    if (!this._risks.has(id)) return;
    const removed = this._risks.get(id);
    this._risks.delete(id);
    this._stateVersion++;
    this._emit({ type: 'risk', path: 'remove', value: deepClone(removed) });
  }

  _autoRiskLevel(prob, impact) {
    const s = (prob || 3) * (impact || 3);
    if (s >= 20) return 'critical';
    if (s >= 12) return 'high';
    if (s >= 6) return 'medium';
    return 'low';
  }

  // -----------------------------------------------------------------------
  // Resource CRUD
  // -----------------------------------------------------------------------

  addResource(resource) {
    const r = deepClone(resource);
    if (!r.id) r.id = uid();
    r.name = r.name || 'Unnamed Resource';
    r.department = r.department || '';
    r.role = r.role || '';
    r.tasks = r.tasks || [];
    r.maxCapacity = r.maxCapacity ?? 100;
    this._resources.set(r.id, r);
    this._stateVersion++;
    this._emit({ type: 'resource', path: 'add', value: deepClone(r) });
  }

  updateResource(id, changes) {
    const existing = this._resources.get(id);
    if (!existing) return;
    const merged = { ...existing, ...deepClone(changes), id };
    this._resources.set(id, merged);
    this._stateVersion++;
    this._emit({ type: 'resource', path: 'update', value: deepClone(merged) });
  }

  removeResource(id) {
    if (!this._resources.has(id)) return;
    const removed = this._resources.get(id);
    this._resources.delete(id);
    this._stateVersion++;
    this._emit({ type: 'resource', path: 'remove', value: deepClone(removed) });
  }

  // -----------------------------------------------------------------------
  // Import / Export
  // -----------------------------------------------------------------------

  /**
   * Import data, merging with existing state.
   * All imported entities get fresh IDs to avoid collisions.
   * Accepts { projects?, tasks?, risks?, resources? } as arrays or objects.
   */
  importData(data) {
    this.batch(() => {
      // Build an ID-mapping table so that internal references can be rewritten
      const idMap = new Map(); // oldId -> newId

      if (data.projects) {
        const projects = Array.isArray(data.projects) ? data.projects : Object.values(data.projects);
        for (const p of projects) {
          const oldId = p.id;
          const newId = uid();
          idMap.set(oldId, newId);
          this.addProject({ ...p, id: newId });
        }
      }

      if (data.tasks) {
        const tasks = Array.isArray(data.tasks) ? data.tasks : Object.values(data.tasks);
        for (const t of tasks) {
          const oldId = t.id;
          const newId = uid();
          idMap.set(oldId, newId);
          // Remap projectId
          const newProjectId = idMap.get(t.projectId) || t.projectId || '';
          // Remap dependencies
          const newDeps = (t.dependencies || []).map(d => idMap.get(d) || d);
          // Remap cross-project deps
          const newCross = (t.crossProjectDeps || []).map(cd => ({
            projectId: idMap.get(cd.projectId) || cd.projectId,
            taskId: idMap.get(cd.taskId) || cd.taskId,
          }));
          this.addTask({ ...t, id: newId, projectId: newProjectId, dependencies: newDeps, crossProjectDeps: newCross });
        }
      }

      if (data.risks) {
        const risks = Array.isArray(data.risks) ? data.risks : Object.values(data.risks);
        for (const r of risks) {
          const newId = uid();
          const newProjectId = idMap.get(r.projectId) || r.projectId || '';
          const newTaskId = idMap.get(r.taskId) || r.taskId || '';
          this.addRisk({ ...r, id: newId, projectId: newProjectId, taskId: newTaskId });
        }
      }

      if (data.resources) {
        const resources = Array.isArray(data.resources) ? data.resources : Object.values(data.resources);
        for (const r of resources) {
          const newId = uid();
          const newTasks = (r.tasks || []).map(rt => ({
            taskId: idMap.get(rt.taskId) || rt.taskId,
            projectId: idMap.get(rt.projectId) || rt.projectId,
            allocation: rt.allocation,
          }));
          this.addResource({ ...r, id: newId, tasks: newTasks });
        }
      }
    });
  }

  /** Export all data as a plain JSON-serialisable object */
  exportData() {
    return {
      projects: Array.from(this._projects.values()).map(deepClone),
      tasks: Array.from(this._tasks.values()).map(deepClone),
      risks: Array.from(this._risks.values()).map(deepClone),
      resources: Array.from(this._resources.values()).map(deepClone),
    };
  }

  // -----------------------------------------------------------------------
  // Atomic snapshot / restore  (used by HistoryManager and export)
  // -----------------------------------------------------------------------

  /**
   * Capture an atomic snapshot of the entire store state including the
   * current version counter.  Snapshots are plain objects safe for
   * structuredClone / JSON serialisation.
   */
  getSnapshot() {
    return {
      projects: Array.from(this._projects.values()).map(deepClone),
      tasks: Array.from(this._tasks.values()).map(deepClone),
      risks: Array.from(this._risks.values()).map(deepClone),
      resources: Array.from(this._resources.values()).map(deepClone),
      filters: deepClone(this._filters),
      selectedProjectId: this._selectedProjectId,
      view: this._view,
      version: this._stateVersion,
    };
  }

  /**
   * Atomically replace internal state from a snapshot and bump the version
   * counter.  Emits a single 'restore' event so that ALL engines and views
   * know to invalidate caches and re-render from scratch.
   *
   * This is the ONLY correct way to restore state (undo/redo/scenario-load).
   * Direct Map manipulation without emitting 'restore' will leave engines
   * out of sync.
   */
  restoreFromSnapshot(snapshot) {
    // Clear all internal maps
    this._projects.clear();
    this._tasks.clear();
    this._risks.clear();
    this._resources.clear();

    // Restore data from snapshot
    for (const p of (snapshot.projects || [])) {
      this._projects.set(p.id, deepClone(p));
    }
    for (const t of (snapshot.tasks || [])) {
      this._tasks.set(t.id, deepClone(t));
    }
    for (const r of (snapshot.risks || [])) {
      this._risks.set(r.id, deepClone(r));
    }
    for (const res of (snapshot.resources || [])) {
      this._resources.set(res.id, deepClone(res));
    }

    // Restore filter/view state
    if (snapshot.filters) {
      this._filters = deepClone(snapshot.filters);
    }
    if (snapshot.selectedProjectId !== undefined) {
      this._selectedProjectId = snapshot.selectedProjectId;
    }
    if (snapshot.view) {
      this._view = snapshot.view;
    }

    // Bump version so stale worker results are discarded
    this._stateVersion++;

    // Emit a dedicated 'restore' event — engines MUST listen for this
    // to invalidate their caches.  This is emitted outside of batch()
    // so that it is delivered synchronously and immediately.
    const restoreEvent = {
      type: 'restore',
      path: 'full',
      value: { version: this._stateVersion },
    };
    for (const { listener, typeFilter } of this._subscribers) {
      if (!typeFilter || typeFilter === 'restore' || typeFilter === 'batch') {
        try { listener(restoreEvent); } catch (e) { console.error('Store subscriber error:', e); }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Filtered getters
  // -----------------------------------------------------------------------

  /** Return projects matching current filters */
  getFilteredProjects() {
    const f = this._filters;
    const search = f.search.toLowerCase();
    return Array.from(this._projects.values())
      .filter(p => {
        if (f.department !== 'all' && p.department !== f.department) return false;
        if (f.projectManager !== 'all' && p.projectManager !== f.projectManager) return false;
        if (f.status !== 'all' && p.status !== f.status) return false;
        if (search && !p.name.toLowerCase().includes(search) && !p.department.toLowerCase().includes(search)) return false;
        return true;
      })
      .map(deepClone);
  }

  /** Return tasks matching current filters (and selected project) */
  getFilteredTasks() {
    const f = this._filters;
    const search = f.search.toLowerCase();
    const selProject = this._selectedProjectId;
    return Array.from(this._tasks.values())
      .filter(t => {
        if (selProject && t.projectId !== selProject) return false;
        if (f.status !== 'all' && t.status !== f.status) return false;
        if (search && !t.name.toLowerCase().includes(search) && !t.assignee.toLowerCase().includes(search)) return false;
        // Department filter: match task's project department
        if (f.department !== 'all') {
          const proj = this._projects.get(t.projectId);
          if (!proj || proj.department !== f.department) return false;
        }
        if (f.projectManager !== 'all') {
          const proj = this._projects.get(t.projectId);
          if (!proj || proj.projectManager !== f.projectManager) return false;
        }
        return true;
      })
      .map(deepClone);
  }

  /** Return risks matching current filters */
  getFilteredRisks() {
    const f = this._filters;
    const search = f.search.toLowerCase();
    const selProject = this._selectedProjectId;
    return Array.from(this._risks.values())
      .filter(r => {
        if (selProject && r.projectId !== selProject) return false;
        if (f.riskLevel !== 'all' && r.level !== f.riskLevel) return false;
        if (search && !r.name.toLowerCase().includes(search) && !r.owner.toLowerCase().includes(search)) return false;
        return true;
      })
      .map(deepClone);
  }

  /** All tasks belonging to a specific project */
  getProjectTasks(projectId) {
    return Array.from(this._tasks.values())
      .filter(t => t.projectId === projectId)
      .map(deepClone);
  }

  /** All risks belonging to a specific project */
  getProjectRisks(projectId) {
    return Array.from(this._risks.values())
      .filter(r => r.projectId === projectId)
      .map(deepClone);
  }

  /** All resources assigned to tasks in a specific project */
  getProjectResources(projectId) {
    const taskIds = new Set(
      Array.from(this._tasks.values()).filter(t => t.projectId === projectId).map(t => t.id)
    );
    return Array.from(this._resources.values())
      .filter(r => r.tasks.some(rt => taskIds.has(rt.taskId)))
      .map(deepClone);
  }

  /** Workload for a specific assignee (by name) */
  getAssigneeWorkload(assignee) {
    const tasks = Array.from(this._tasks.values())
      .filter(t => t.assignee === assignee && t.status !== 'completed')
      .map(deepClone);

    // Calculate total allocation from resource records
    let totalAllocation = 0;
    for (const r of this._resources.values()) {
      if (r.name === assignee) {
        totalAllocation += r.tasks.reduce((sum, rt) => sum + rt.allocation, 0);
      }
    }
    // If no resource record, estimate from task count (rough: 100% per active task)
    if (totalAllocation === 0 && tasks.length > 0) {
      totalAllocation = tasks.length * 100;
    }
    return { tasks, totalAllocation };
  }

  // -----------------------------------------------------------------------
  // Filters
  // -----------------------------------------------------------------------

  setFilter(key, value) {
    if (!(key in DEFAULT_FILTERS)) return;
    this._filters[key] = value;
    this._emit({ type: 'filter', path: key, value });
  }

  resetFilters() {
    Object.assign(this._filters, DEFAULT_FILTERS);
    this._emit({ type: 'filter', path: 'reset', value: { ...DEFAULT_FILTERS } });
  }

  /** Compute available filter option values from current data */
  getFilterOptions() {
    const departments = new Set();
    const projectManagers = new Set();
    const statuses = new Set();
    const riskLevels = new Set();
    const assignees = new Set();

    for (const p of this._projects.values()) {
      if (p.department) departments.add(p.department);
      if (p.projectManager) projectManagers.add(p.projectManager);
      if (p.status) statuses.add(p.status);
    }
    for (const t of this._tasks.values()) {
      if (t.status) statuses.add(t.status);
      if (t.assignee) assignees.add(t.assignee);
    }
    for (const r of this._risks.values()) {
      if (r.level) riskLevels.add(r.level);
    }

    return {
      departments: [...departments].sort(),
      projectManagers: [...projectManagers].sort(),
      statuses: [...statuses].sort(),
      riskLevels: [...riskLevels].sort(),
      assignees: [...assignees].sort(),
    };
  }

  // -----------------------------------------------------------------------
  // Scenarios (save / load snapshots)
  // -----------------------------------------------------------------------

  /** Capture the current state as a named scenario */
  saveScenario(name) {
    const snapshot = deepClone(this.exportData());
    this._scenarios.push({
      name: name || `Scenario ${this._scenarios.length + 1}`,
      timestamp: Date.now(),
      snapshot,
    });
    this._emit({ type: 'scenario', path: 'save', value: { name, index: this._scenarios.length - 1 } });
  }

  /** Restore state from a saved scenario */
  loadScenario(index) {
    if (index < 0 || index >= this._scenarios.length) return;
    const scenario = this._scenarios[index];
    const snapshot = deepClone(scenario.snapshot);

    // Use restoreFromSnapshot for atomic restore with proper event emission
    this.restoreFromSnapshot(snapshot);

    this._emit({ type: 'scenario', path: 'load', value: { name: scenario.name, index } });
  }

  /** Delete a saved scenario by index */
  deleteScenario(index) {
    if (index < 0 || index >= this._scenarios.length) return;
    const removed = this._scenarios.splice(index, 1);
    this._emit({ type: 'scenario', path: 'delete', value: { name: removed[0].name, index } });
  }

  /** List all saved scenarios */
  getScenarios() {
    return this._scenarios.map((s, i) => ({
      name: s.name,
      timestamp: s.timestamp,
      index: i,
    }));
  }

  // -----------------------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------------------

  getStats() {
    const totalProjects = this._projects.size;
    const totalTasks = this._tasks.size;

    // Delayed = tasks whose actual end or planned end is past today and not completed
    const now = Date.now();
    let delayedTasks = 0;
    for (const t of this._tasks.values()) {
      if (t.status === 'completed') continue;
      const end = t.actualEnd || t.plannedEnd;
      if (end && new Date(end).getTime() < now) delayedTasks++;
    }

    // Critical risks (level = critical or high)
    let criticalRisks = 0;
    for (const r of this._risks.values()) {
      if (r.level === 'critical' || r.level === 'high') criticalRisks++;
    }

    // Resource conflicts: any resource whose total allocation > maxCapacity
    let resourceConflicts = 0;
    for (const res of this._resources.values()) {
      const total = res.tasks.reduce((sum, rt) => sum + rt.allocation, 0);
      if (total > res.maxCapacity) resourceConflicts++;
    }

    return { totalProjects, totalTasks, delayedTasks, criticalRisks, resourceConflicts };
  }
}
