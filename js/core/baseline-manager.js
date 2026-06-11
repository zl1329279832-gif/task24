// Baseline Manager — CRUD for immutable baselines, localStorage persistence,
// import/export.  Baselines are deliberately stored OUTSIDE the undo/redo
// history stack so that undo/redo never destroys saved baselines.

const STORAGE_KEY = 'pmo-baselines';
const STORAGE_VERSION = 1;
const DEFAULT_MAX_BASELINES = 50;

/* -------------------------------------------------------------------------- */
/*  Utility                                                                    */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  try { return structuredClone(obj); } catch (_) { /* fallback */ }
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

/* -------------------------------------------------------------------------- */
/*  BaselineManager                                                            */
/* -------------------------------------------------------------------------- */

export class BaselineManager {
  /**
   * @param {import('../core/store.js').Store} store
   * @param {Object} deps
   * @param {import('../core/dependency-engine.js').DependencyEngine} deps.dependencyEngine
   * @param {import('../engine/resource-engine.js').ResourceEngine}   deps.resourceEngine
   * @param {import('../engine/risk-engine.js').RiskEngine}           deps.riskEngine
   * @param {number} [deps.maxBaselines]
   */
  constructor(store, deps) {
    this._store = store;
    this._depEngine = deps.dependencyEngine;
    this._resEngine = deps.resourceEngine;
    this._riskEngine = deps.riskEngine;
    this._maxBaselines = deps.maxBaselines ?? DEFAULT_MAX_BASELINES;
    /** @type {Map<string, object>} */
    this._baselines = new Map();
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Save a new baseline from current store state.
   * @param {string} name
   * @param {string} [description]
   * @returns {string} baseline id
   */
  saveBaseline(name, description) {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 12);

    // 1. Capture snapshot
    const snapshot = deepClone(this._store.exportData());

    // 2. Compute metrics from the snapshot (NOT from live engines)
    const metrics = this._computeMetricsFromSnapshot(snapshot);

    // 3. Build baseline object with version metadata
    const baseline = {
      id,
      name: name || `Baseline ${this._baselines.size + 1}`,
      description: description || '',
      createdAt: Date.now(),
      snapshot,
      metrics,
      frozen: true,
      stateVersion: this._store.state.stateVersion,
      portfolioId: this._store.state.portfolioId,
      metricsVersion: this._store.state.stateVersion,
    };

    // 4. Deep freeze for immutability
    deepFreeze(baseline);

    // 5. Store
    this._baselines.set(id, baseline);

    // 6. Enforce max limit (evict oldest)
    this._enforceMaxLimit();

    // 7. Persist
    this.saveToStorage();

    // 8. Notify
    this._store.emitBaselineEvent('save', { id, name: baseline.name });

    return id;
  }

  /** Return a deep clone of the baseline (safe to mutate) */
  getBaseline(id) {
    const bl = this._baselines.get(id);
    return bl ? deepClone(bl) : null;
  }

  /** Return all baselines sorted by createdAt descending */
  getAllBaselines() {
    return Array.from(this._baselines.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(deepClone);
  }

  /** Delete a baseline by id */
  deleteBaseline(id) {
    if (!this._baselines.has(id)) return false;
    const bl = this._baselines.get(id);
    this._baselines.delete(id);

    // If this was the active baseline, clear it
    if (this._store.state.activeBaselineId === id) {
      this._store.state.activeBaselineId = null;
    }

    this.saveToStorage();
    this._store.emitBaselineEvent('delete', { id, name: bl.name });
    return true;
  }

  /** Rename a baseline */
  renameBaseline(id, newName) {
    const bl = this._baselines.get(id);
    if (!bl) return false;

    // Need to create a new unfrozen object, update, re-freeze
    const updated = deepClone(bl);
    updated.name = newName;
    deepFreeze(updated);
    this._baselines.set(id, updated);

    this.saveToStorage();
    this._store.emitBaselineEvent('rename', { id, name: newName });
    return true;
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  /** Set the active baseline for diff comparison */
  setActiveBaseline(id) {
    if (id !== null && !this._baselines.has(id)) return false;
    this._store.state.activeBaselineId = id;
    return true;
  }

  /** Get the active baseline (deep clone) or null */
  getActiveBaseline() {
    const id = this._store.state.activeBaselineId;
    return id ? this.getBaseline(id) : null;
  }

  /** Clear active baseline */
  clearActiveBaseline() {
    this._store.state.activeBaselineId = null;
  }

  // -------------------------------------------------------------------------
  // Snapshot access
  // -------------------------------------------------------------------------

  /** Get deep clone of a baseline's snapshot */
  getBaselineSnapshot(id) {
    const bl = this._baselines.get(id);
    return bl ? deepClone(bl.snapshot) : null;
  }

  /** Convenience: get active baseline's snapshot */
  getActiveBaselineSnapshot() {
    const id = this._store.state.activeBaselineId;
    return id ? this.getBaselineSnapshot(id) : null;
  }

  /** Get a baseline's metrics */
  getBaselineMetrics(id) {
    const bl = this._baselines.get(id);
    return bl ? deepClone(bl.metrics) : null;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Save all baselines to localStorage */
  saveToStorage() {
    try {
      const data = {
        version: STORAGE_VERSION,
        activeBaselineId: this._store.state.activeBaselineId,
        baselines: Array.from(this._baselines.values()),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('[BaselineManager] localStorage save failed:', err);
    }
  }

  /** Load baselines from localStorage */
  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || data.version !== STORAGE_VERSION) return;

      this._baselines.clear();
      for (const bl of (data.baselines || [])) {
        if (bl && bl.id && bl.snapshot) {
          // Backfill legacy baselines with version metadata
          if (bl.stateVersion === undefined) bl.stateVersion = 0;
          if (bl.portfolioId === undefined) bl.portfolioId = 'legacy';
          if (bl.metricsVersion === undefined) bl.metricsVersion = bl.stateVersion;
          deepFreeze(bl);
          this._baselines.set(bl.id, bl);
        }
      }

      // Restore active baseline id if it still exists
      if (data.activeBaselineId && this._baselines.has(data.activeBaselineId)) {
        this._store.state.activeBaselineId = data.activeBaselineId;
      }
    } catch (err) {
      console.warn('[BaselineManager] localStorage load failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Export / Import
  // -------------------------------------------------------------------------

  /** Export all baselines as a JSON string */
  exportBaselines() {
    const data = {
      version: STORAGE_VERSION,
      exportedAt: new Date().toISOString(),
      baselines: Array.from(this._baselines.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import baselines from a JSON string.
   * @param {string} jsonString
   * @returns {{ imported: number, errors: string[] }}
   */
  importBaselines(jsonString) {
    const errors = [];
    let imported = 0;

    try {
      const data = JSON.parse(jsonString);
      if (!data || !Array.isArray(data.baselines)) {
        errors.push('Invalid format: missing baselines array');
        return { imported, errors };
      }

      for (const bl of data.baselines) {
        if (!this.validateBaseline(bl)) {
          errors.push(`Skipped invalid baseline: ${bl.name || bl.id || 'unknown'}`);
          continue;
        }
        // If same id exists, skip (don't overwrite)
        if (this._baselines.has(bl.id)) {
          // Assign a new id to avoid conflicts
          bl.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2, 12);
        }
        deepFreeze(bl);
        this._baselines.set(bl.id, bl);
        imported++;
      }

      this._enforceMaxLimit();
      this.saveToStorage();
      this._store.emitBaselineEvent('import', { imported, errors });
    } catch (err) {
      errors.push('Parse error: ' + (err.message || String(err)));
    }

    return { imported, errors };
  }

  /** Validate structural integrity of a baseline object */
  validateBaseline(baseline) {
    if (!baseline || typeof baseline !== 'object') return false;
    if (!baseline.id || !baseline.snapshot) return false;
    if (!baseline.snapshot.tasks || !Array.isArray(baseline.snapshot.tasks)) return false;
    if (!baseline.snapshot.projects || !Array.isArray(baseline.snapshot.projects)) return false;
    if (!baseline.snapshot.risks || !Array.isArray(baseline.snapshot.risks)) return false;
    if (!baseline.snapshot.resources || !Array.isArray(baseline.snapshot.resources)) return false;
    // Version fields are optional but must be valid if present
    if (baseline.stateVersion !== undefined && (typeof baseline.stateVersion !== 'number' || baseline.stateVersion < 0)) return false;
    if (baseline.metricsVersion !== undefined && (typeof baseline.metricsVersion !== 'number' || baseline.metricsVersion < 0)) return false;
    return true;
  }

  /**
   * Check whether a baseline's version metadata is compatible with the
   * current store state.  Returns a structured compatibility report.
   * @param {string} baselineId
   * @returns {{ compatible: boolean, reason: string, baselineVersion: number, currentVersion: number, portfolioMatch: boolean, versionDelta: number }}
   */
  validateVersionCompatibility(baselineId) {
    const bl = this._baselines.get(baselineId);
    if (!bl) {
      return {
        compatible: false,
        reason: 'Baseline not found',
        baselineVersion: 0,
        currentVersion: this._store.state.stateVersion,
        portfolioMatch: false,
        versionDelta: 0,
      };
    }

    const baselineVersion = bl.stateVersion ?? 0;
    const currentVersion = this._store.state.stateVersion;
    const baselinePortfolio = bl.portfolioId ?? 'legacy';
    const currentPortfolio = this._store.state.portfolioId;
    const portfolioMatch = baselinePortfolio === currentPortfolio;
    const versionDelta = currentVersion - baselineVersion;

    // Legacy baselines (pre-versioning) are not considered compatible
    if (baselinePortfolio === 'legacy') {
      return {
        compatible: false,
        reason: 'Legacy baseline (pre-versioning) — metrics may not reflect current state lineage',
        baselineVersion,
        currentVersion,
        portfolioMatch: false,
        versionDelta,
      };
    }

    if (!portfolioMatch) {
      return {
        compatible: false,
        reason: 'Portfolio lineage changed (state was imported or fully replaced since baseline was saved)',
        baselineVersion,
        currentVersion,
        portfolioMatch: false,
        versionDelta,
      };
    }

    return {
      compatible: true,
      reason: 'Version compatible',
      baselineVersion,
      currentVersion,
      portfolioMatch: true,
      versionDelta,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Compute metrics entirely from a snapshot's arrays (NOT from live engines).
   * This ensures the baseline records a true point-in-time record that
   * cannot drift when the store is later undone/redone.
   */
  _computeMetricsFromSnapshot(snapshot) {
    const metrics = {
      criticalPathTaskIds: [],
      totalDuration: 0,
      resourceLoads: [],
      riskLevels: [],
      taskCount: snapshot.tasks.length,
      projectCount: snapshot.projects.length,
      riskCount: snapshot.risks.length,
      resourceCount: snapshot.resources.length,
    };

    // Critical path — self-contained CPM on the frozen task array
    try {
      const cp = this._computeCriticalPathFromTasks(snapshot.tasks || []);
      metrics.criticalPathTaskIds = cp.taskIds || [];
      metrics.totalDuration = cp.totalDuration || 0;
    } catch (_) { /* tasks may be empty or malformed */ }

    // Resource overloads — computed from snapshot arrays
    try {
      metrics.resourceLoads = this._computeResourceLoadsFromSnapshot(snapshot);
    } catch (_) { /* */ }

    // Risk levels — direct from snapshot
    metrics.riskLevels = (snapshot.risks || []).map(r => ({
      riskId: r.id,
      level: r.level || 'low',
      score: (r.probability || 1) * (r.impact || 1),
    }));

    return metrics;
  }

  /**
   * Self-contained Critical Path Method on a task array.
   * Uses Kahn's topological sort + forward/backward pass.
   * Returns { taskIds: string[], totalDuration: number }.
   */
  _computeCriticalPathFromTasks(tasks) {
    if (!tasks || tasks.length === 0) return { taskIds: [], totalDuration: 0 };

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const DAY_MS = 86_400_000;

    const toMs = (d) => {
      if (!d) return NaN;
      const ms = new Date(d).getTime();
      return ms;
    };

    // Build predecessor/successor adjacency
    const predecessors = new Map();
    const successors = new Map();
    for (const t of tasks) {
      predecessors.set(t.id, []);
      successors.set(t.id, []);
    }

    for (const t of tasks) {
      const deps = [
        ...(t.dependencies || []),
        ...(t.crossProjectDeps || []).map(cpd => cpd.taskId),
      ];
      for (const depId of deps) {
        if (taskMap.has(depId)) {
          if (!predecessors.get(t.id).includes(depId)) predecessors.get(t.id).push(depId);
          if (!successors.get(depId).includes(t.id)) successors.get(depId).push(t.id);
        }
      }
    }

    // Topological sort (Kahn's)
    const inDegree = new Map();
    for (const t of tasks) inDegree.set(t.id, predecessors.get(t.id).length);
    const queue = [];
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);

    const topoOrder = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      topoOrder.push(cur);
      for (const succ of (successors.get(cur) || [])) {
        const newDeg = inDegree.get(succ) - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) queue.push(succ);
      }
    }
    // Append cycle tasks at end
    if (topoOrder.length < tasks.length) {
      const inTopo = new Set(topoOrder);
      for (const t of tasks) if (!inTopo.has(t.id)) topoOrder.push(t.id);
    }

    // Compute durations
    const durations = new Map();
    for (const t of tasks) {
      const start = toMs(t.plannedStart);
      const end = toMs(t.plannedEnd);
      const dur = (Number.isFinite(start) && Number.isFinite(end))
        ? Math.max(1, Math.round((end - start) / DAY_MS))
        : (t.estimatedDays || 1);
      durations.set(t.id, dur);
    }

    // Forward pass — ES/EF (in days from 0)
    const ES = new Map();
    const EF = new Map();
    for (const tid of topoOrder) {
      let maxPredEF = 0;
      for (const pred of (predecessors.get(tid) || [])) {
        if ((EF.get(pred) || 0) > maxPredEF) maxPredEF = EF.get(pred);
      }
      ES.set(tid, maxPredEF);
      EF.set(tid, maxPredEF + durations.get(tid));
    }

    // Project duration
    let projectDuration = 0;
    for (const t of tasks) {
      if ((EF.get(t.id) || 0) > projectDuration) projectDuration = EF.get(t.id);
    }

    // Backward pass — LF/LS
    const LF = new Map();
    const LS = new Map();
    for (let i = topoOrder.length - 1; i >= 0; i--) {
      const tid = topoOrder[i];
      let minSuccLS = projectDuration;
      for (const succ of (successors.get(tid) || [])) {
        if ((LS.get(succ) ?? projectDuration) < minSuccLS) minSuccLS = LS.get(succ);
      }
      LF.set(tid, minSuccLS);
      LS.set(tid, minSuccLS - durations.get(tid));
    }

    // Identify critical tasks (total float ≈ 0)
    const criticalIds = [];
    for (const t of tasks) {
      const totalFloat = (LS.get(t.id) || 0) - (ES.get(t.id) || 0);
      if (Math.abs(totalFloat) < 0.01) criticalIds.push(t.id);
    }

    return { taskIds: criticalIds, totalDuration: projectDuration };
  }

  /**
   * Compute resource overload information from snapshot arrays.
   * Returns array of { resourceId, peakAllocation, overloadedDays }.
   */
  _computeResourceLoadsFromSnapshot(snapshot) {
    const taskMap = new Map((snapshot.tasks || []).map(t => [t.id, t]));
    const loads = [];

    for (const resource of (snapshot.resources || [])) {
      if (!resource.tasks || resource.tasks.length === 0) continue;

      const maxCap = resource.maxCapacity || 100;
      let peakAllocation = 0;
      let overloadedDays = 0;

      // Build daily allocation using event sweep
      const events = new Map(); // dateStr -> delta
      for (const assignment of resource.tasks) {
        const task = taskMap.get(assignment.taskId);
        if (!task || !task.plannedStart || !task.plannedEnd) continue;

        const alloc = assignment.allocation || 0;
        const start = new Date(task.plannedStart + 'T00:00:00');
        const end = new Date(task.plannedEnd + 'T00:00:00');
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

        // Simple day-by-day sweep
        const d = new Date(start);
        while (d <= end) {
          const dow = d.getDay();
          if (dow !== 0 && dow !== 6) {
            const key = d.toISOString().slice(0, 10);
            events.set(key, (events.get(key) || 0) + alloc);
          }
          d.setDate(d.getDate() + 1);
        }
      }

      for (const [, total] of events) {
        if (total > peakAllocation) peakAllocation = total;
        if (total > maxCap) overloadedDays++;
      }

      if (peakAllocation > 0) {
        loads.push({
          resourceId: resource.id,
          peakAllocation,
          overloadedDays,
        });
      }
    }

    return loads;
  }

  /** Evict oldest baselines if over the limit */
  _enforceMaxLimit() {
    while (this._baselines.size > this._maxBaselines) {
      // Find oldest
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, bl] of this._baselines) {
        if (bl.createdAt < oldestTime) {
          oldestTime = bl.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this._baselines.delete(oldestId);
        if (this._store.state.activeBaselineId === oldestId) {
          this._store.state.activeBaselineId = null;
        }
      } else {
        break;
      }
    }
  }
}
