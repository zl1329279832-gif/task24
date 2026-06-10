/**
 * baseline-manager.js
 * Manages baseline versions for the portfolio management dashboard.
 *
 * Baselines are stored independently from the Store's data Maps, so
 * undo/redo (which operates via store.replaceAll) never touches them.
 * Each baseline is a frozen snapshot of projects, tasks, risks, and
 * resources at the time of creation.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'bl-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

const STORAGE_KEY = 'pmo-baselines';

// ---------------------------------------------------------------------------
// BaselineManager
// ---------------------------------------------------------------------------

export class BaselineManager {
  /**
   * @param {import('./store.js').Store} store
   */
  constructor(store) {
    this._store = store;

    /** @type {Map<string, Baseline>} */
    this._baselines = new Map();

    /** Currently active baseline for comparison (null = none) */
    this._activeBaselineId = null;

    /** Subscriber list */
    this._subscribers = [];
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  subscribe(listener) {
    this._subscribers.push(listener);
    return () => {
      const idx = this._subscribers.indexOf(listener);
      if (idx !== -1) this._subscribers.splice(idx, 1);
    };
  }

  _emit(event) {
    for (const fn of this._subscribers) {
      try { fn(event); } catch (e) { console.error('BaselineManager subscriber error:', e); }
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new baseline from the current store state.
   * @param {string} name
   * @param {string} [description]
   * @returns {string} baseline id
   */
  createBaseline(name, description) {
    const id = uid();
    const snapshot = this._store.getSnapshot();
    const baseline = {
      id,
      name: name || `Baseline ${this._baselines.size + 1}`,
      description: description || '',
      createdAt: new Date().toISOString(),
      snapshot: {
        projects: snapshot.projects,
        tasks: snapshot.tasks,
        risks: snapshot.risks,
        resources: snapshot.resources,
      },
    };
    this._baselines.set(id, baseline);
    this._emit({ type: 'baseline', action: 'create', id, name: baseline.name });
    return id;
  }

  /**
   * Get a deep-cloned baseline by id.
   * @param {string} id
   * @returns {Baseline|null}
   */
  getBaseline(id) {
    const bl = this._baselines.get(id);
    return bl ? deepClone(bl) : null;
  }

  /**
   * List all baselines (metadata only, no snapshot data).
   * @returns {Array<{id, name, description, createdAt}>}
   */
  listBaselines() {
    return Array.from(this._baselines.values()).map(bl => ({
      id: bl.id,
      name: bl.name,
      description: bl.description,
      createdAt: bl.createdAt,
      isActive: bl.id === this._activeBaselineId,
    }));
  }

  /**
   * Delete a baseline.
   * @param {string} id
   */
  deleteBaseline(id) {
    if (!this._baselines.has(id)) return;
    this._baselines.delete(id);
    if (this._activeBaselineId === id) {
      this._activeBaselineId = null;
    }
    this._emit({ type: 'baseline', action: 'delete', id });
  }

  /**
   * Rename a baseline.
   * @param {string} id
   * @param {string} name
   * @param {string} [description]
   */
  renameBaseline(id, name, description) {
    const bl = this._baselines.get(id);
    if (!bl) return;
    if (name !== undefined) bl.name = name;
    if (description !== undefined) bl.description = description;
    this._emit({ type: 'baseline', action: 'rename', id });
  }

  // -----------------------------------------------------------------------
  // Active baseline (for comparison)
  // -----------------------------------------------------------------------

  /**
   * Set the active baseline for comparison.
   * Pass null to clear.
   * @param {string|null} id
   */
  setActiveBaseline(id) {
    if (id !== null && !this._baselines.has(id)) return;
    this._activeBaselineId = id;
    this._emit({ type: 'baseline', action: 'activate', id });
  }

  /**
   * Get the active baseline's id.
   * @returns {string|null}
   */
  getActiveBaselineId() {
    return this._activeBaselineId;
  }

  /**
   * Get the active baseline's snapshot data (deep-cloned).
   * Returns null if no active baseline.
   * @returns {{projects, tasks, risks, resources}|null}
   */
  getActiveBaseline() {
    if (!this._activeBaselineId) return null;
    const bl = this._baselines.get(this._activeBaselineId);
    if (!bl) return null;
    return deepClone(bl.snapshot);
  }

  /**
   * Get the active baseline's metadata.
   * @returns {{id, name, description, createdAt}|null}
   */
  getActiveBaselineInfo() {
    if (!this._activeBaselineId) return null;
    const bl = this._baselines.get(this._activeBaselineId);
    if (!bl) return null;
    return { id: bl.id, name: bl.name, description: bl.description, createdAt: bl.createdAt };
  }

  // -----------------------------------------------------------------------
  // Restore
  // -----------------------------------------------------------------------

  /**
   * Restore store state from a baseline.
   * @param {string} id
   * @returns {boolean} success
   */
  restoreBaseline(id) {
    const bl = this._baselines.get(id);
    if (!bl) return false;
    const snapshot = deepClone(bl.snapshot);
    this._store.replaceAll(snapshot);
    this._emit({ type: 'baseline', action: 'restore', id });
    return true;
  }

  // -----------------------------------------------------------------------
  // Import / Export
  // -----------------------------------------------------------------------

  /**
   * Export a single baseline as a JSON string.
   * @param {string} id
   * @returns {string|null}
   */
  exportBaseline(id) {
    const bl = this._baselines.get(id);
    if (!bl) return null;
    return JSON.stringify({
      version: 1,
      type: 'pmo-baseline',
      baselines: [deepClone(bl)],
    }, null, 2);
  }

  /**
   * Export all baselines as a JSON string.
   * @returns {string}
   */
  exportAllBaselines() {
    return JSON.stringify({
      version: 1,
      type: 'pmo-baseline',
      activeBaselineId: this._activeBaselineId,
      baselines: Array.from(this._baselines.values()).map(deepClone),
    }, null, 2);
  }

  /**
   * Import baselines from a JSON string.
   * @param {string} jsonString
   * @returns {{success: boolean, imported: number, errors: string[]}}
   */
  importBaselines(jsonString) {
    const errors = [];
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      return { success: false, imported: 0, errors: ['Invalid JSON: ' + e.message] };
    }

    if (!data || data.type !== 'pmo-baseline' || !Array.isArray(data.baselines)) {
      return { success: false, imported: 0, errors: ['Invalid baseline file format'] };
    }

    let imported = 0;
    for (const bl of data.baselines) {
      if (!bl.id || !bl.snapshot) {
        errors.push(`Skipped baseline "${bl.name || 'unnamed'}": missing id or snapshot`);
        continue;
      }
      // Validate snapshot structure
      if (!bl.snapshot.projects || !bl.snapshot.tasks) {
        errors.push(`Skipped baseline "${bl.name}": incomplete snapshot data`);
        continue;
      }
      // Generate new id to avoid collisions
      const newId = uid();
      this._baselines.set(newId, {
        id: newId,
        name: bl.name || `Imported Baseline ${imported + 1}`,
        description: bl.description || '',
        createdAt: bl.createdAt || new Date().toISOString(),
        snapshot: deepClone(bl.snapshot),
      });
      imported++;
    }

    this._emit({ type: 'baseline', action: 'import', count: imported });
    return { success: imported > 0, imported, errors };
  }

  // -----------------------------------------------------------------------
  // Persistence (localStorage)
  // -----------------------------------------------------------------------

  /** Save all baselines to localStorage. */
  save() {
    try {
      const data = {
        activeBaselineId: this._activeBaselineId,
        baselines: Array.from(this._baselines.values()).map(deepClone),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[BaselineManager] Failed to save:', e);
    }
  }

  /** Load baselines from localStorage. */
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.baselines)) {
        this._baselines.clear();
        for (const bl of data.baselines) {
          if (bl.id && bl.snapshot) {
            this._baselines.set(bl.id, deepClone(bl));
          }
        }
      }
      if (data.activeBaselineId && this._baselines.has(data.activeBaselineId)) {
        this._activeBaselineId = data.activeBaselineId;
      }
    } catch (e) {
      console.warn('[BaselineManager] Failed to load:', e);
    }
  }

  /** Clear all baselines. */
  clear() {
    this._baselines.clear();
    this._activeBaselineId = null;
    this._emit({ type: 'baseline', action: 'clear' });
  }
}
