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

    // 2. Compute metrics from live engines
    const metrics = this._computeMetrics(snapshot);

    // 3. Build baseline object
    const baseline = {
      id,
      name: name || `Baseline ${this._baselines.size + 1}`,
      description: description || '',
      createdAt: Date.now(),
      storeVersion: this._store.getVersion(),
      snapshot,
      metrics,
      frozen: true,
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

  /**
   * Restore store state from a baseline's snapshot.
   * Used to revert the project set to its state at baseline time.
   * @param {string} id - baseline id
   * @returns {boolean} success
   */
  restoreBaseline(id) {
    const bl = this._baselines.get(id);
    if (!bl || !bl.snapshot) return false;

    const snapshot = deepClone(bl.snapshot);
    this._store.replaceAll({
      projects: snapshot.projects || [],
      tasks: snapshot.tasks || [],
      risks: snapshot.risks || [],
      resources: snapshot.resources || [],
    });

    this._store.emitBaselineEvent('restore', { id, name: bl.name });
    return true;
  }

  /** Get the store version recorded when a baseline was created */
  getBaselineVersion(id) {
    const bl = this._baselines.get(id);
    return bl ? (bl.storeVersion ?? 0) : 0;
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Compute metrics from the current live state */
  _computeMetrics(snapshot) {
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

    // Critical path
    try {
      const cp = this._depEngine.calculateCriticalPath(null);
      metrics.criticalPathTaskIds = cp.taskIds || [];
      metrics.totalDuration = cp.totalDuration || 0;
    } catch (_) { /* engine may not have data */ }

    // Resource overloads
    try {
      const overloads = this._resEngine.findOverloadedResources();
      metrics.resourceLoads = overloads.map(o => ({
        resourceId: o.resourceId,
        peakAllocation: o.peakAllocation || 0,
        overloadedDays: o.overloadedDays || 0,
      }));
    } catch (_) { /* */ }

    // Risk levels
    metrics.riskLevels = snapshot.risks.map(r => ({
      riskId: r.id,
      level: r.level || 'low',
      score: (r.probability || 1) * (r.impact || 1),
    }));

    return metrics;
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
