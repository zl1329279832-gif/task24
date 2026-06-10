/**
 * history-manager.js
 * Undo/redo system for the portfolio management dashboard.
 *
 * Captures state snapshots on significant mutations and maintains
 * a bounded undo stack and a redo stack.  Uses structuredClone for
 * efficient deep copying with a JSON.parse/stringify fallback.
 */

import { Store } from './store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone an object.
 * Prefers structuredClone (available in modern runtimes) and falls
 * back to JSON serialisation for older environments.
 */
function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(obj);
    }
  } catch {
    // structuredClone can throw on non-cloneable values; fall through
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Serialise a Store's data into a plain-object snapshot.
 * Maps are converted to arrays for clone-friendliness.
 */
function snapshotState(store) {
  return {
    projects: Array.from(store.state.projects.values()).map(p => deepClone(p)),
    tasks: Array.from(store.state.tasks.values()).map(t => deepClone(t)),
    risks: Array.from(store.state.risks.values()).map(r => deepClone(r)),
    resources: Array.from(store.state.resources.values()).map(r => deepClone(r)),
    filters: deepClone(store.state.filters),
    selectedProjectId: store.state.selectedProjectId,
    view: store.state.view,
  };
}

/**
 * Restore a Store's data from a snapshot.
 * Uses the store's replaceAll() method for atomic swap, which emits
 * both a 'batch' event and a 'restore' event.  Filter/view state is
 * restored separately since replaceAll only touches data Maps.
 */
function restoreState(store, snapshot) {
  store.replaceAll({
    projects: snapshot.projects || [],
    tasks: snapshot.tasks || [],
    risks: snapshot.risks || [],
    resources: snapshot.resources || [],
  });

  // Restore filter/view state (these are not part of replaceAll)
  if (snapshot.filters) {
    store._filters = deepClone(snapshot.filters);
  }
  if (snapshot.selectedProjectId !== undefined) {
    store._selectedProjectId = snapshot.selectedProjectId;
  }
  if (snapshot.view) {
    store._view = snapshot.view;
  }
}

/**
 * Compare two snapshots and return true if they differ in meaningful ways.
 * Used to avoid pushing duplicate states.
 */
function snapshotsDiffer(a, b) {
  if (!a || !b) return true;
  // Quick size checks
  if ((a.projects?.length || 0) !== (b.projects?.length || 0)) return true;
  if ((a.tasks?.length || 0) !== (b.tasks?.length || 0)) return true;
  if ((a.risks?.length || 0) !== (b.risks?.length || 0)) return true;
  if ((a.resources?.length || 0) !== (b.resources?.length || 0)) return true;
  // Deep compare via JSON (acceptable cost since we only do this on push)
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// HistoryManager class
// ---------------------------------------------------------------------------

export class HistoryManager {
  /**
   * @param {Store}  store
   * @param {Object} [options]
   * @param {number} [options.maxSize=100]  - maximum undo stack entries
   * @param {boolean} [options.autoCapture=true] - auto-capture on store mutations
   * @param {number} [options.autoCaptureDelay=300] - debounce delay in ms for auto-capture
   */
  constructor(store, options = {}) {
    if (!(store instanceof Store)) {
      throw new TypeError('HistoryManager requires a Store instance');
    }

    /** @type {Store} */
    this._store = store;

    /** Maximum number of undo entries */
    this._maxSize = options.maxSize ?? 100;

    /** Whether to auto-capture on mutations */
    this._autoCapture = options.autoCapture ?? true;

    /** Debounce delay for auto-capture */
    this._autoCaptureDelay = options.autoCaptureDelay ?? 300;

    /**
     * Undo stack -- each entry is { description, timestamp, snapshot }.
     * The most recent state is at the END of the array.
     */
    this._undoStack = [];

    /**
     * Redo stack -- each entry is { description, timestamp, snapshot }.
     * The next redo state is at the END of the array.
     */
    this._redoStack = [];

    /** The snapshot of the very last captured state (to detect no-op changes) */
    this._lastSnapshot = null;

    /** Flag to prevent recursive captures during undo/redo restore */
    this._restoring = false;

    /** Debounce timer handle for auto-capture */
    this._debounceTimer = null;

    /** Unsubscribe function from store subscription */
    this._unsubscribe = null;

    // Set up auto-capture if enabled
    if (this._autoCapture) {
      this._setupAutoCapture();
    }

    // Capture initial state
    this.push('Initial state');
  }

  // -----------------------------------------------------------------------
  // Auto-capture via store subscription
  // -----------------------------------------------------------------------

  /** Subscribe to store mutations and auto-push after a debounce period */
  _setupAutoCapture() {
    this._unsubscribe = this._store.subscribe((event) => {
      // Skip if we're currently restoring state (avoid feedback loop)
      if (this._restoring) return;

      // Only capture on data-mutating events, not on filter/view/restore changes
      const mutatingTypes = new Set(['project', 'task', 'risk', 'resource', 'batch']);
      if (!mutatingTypes.has(event.type)) return;

      // Debounce: reset the timer on each mutation
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        // Auto-push with a generic description
        const desc = this._describeEvent(event);
        this.push(desc);
      }, this._autoCaptureDelay);
    });
  }

  /** Generate a human-readable description for a store event */
  _describeEvent(event) {
    if (event.type === 'batch') {
      const count = Array.isArray(event.value) ? event.value.length : 0;
      return `Batch update (${count} changes)`;
    }
    const typeNames = {
      project: 'Project',
      task: 'Task',
      risk: 'Risk',
      resource: 'Resource',
    };
    const typeName = typeNames[event.type] || event.type;
    const action = event.path || 'modified';
    const name = event.value?.name || '';
    return `${typeName} ${action}${name ? ': ' + name : ''}`;
  }

  // -----------------------------------------------------------------------
  // Core undo/redo operations
  // -----------------------------------------------------------------------

  /**
   * Capture the current state with a description.
   * Clears the redo stack (since we've diverged from the old timeline).
   * @param {string} description - human-readable label for this state
   */
  push(description) {
    const snapshot = snapshotState(this._store);

    // Skip if identical to the last snapshot (avoids noise in history)
    if (!snapshotsDiffer(this._lastSnapshot, snapshot)) {
      return;
    }

    // Push onto undo stack
    this._undoStack.push({
      description: description || 'State change',
      timestamp: Date.now(),
      snapshot: deepClone(snapshot),
    });

    // Trim oldest entries if we exceed the maximum size
    while (this._undoStack.length > this._maxSize + 1) {
      this._undoStack.shift();
    }

    // Clear redo stack -- the future is invalidated
    this._redoStack.length = 0;

    // Remember this snapshot for future comparison
    this._lastSnapshot = snapshot;
  }

  /**
   * Undo: revert to the previous state.
   * Returns { success, description }.
   */
  undo() {
    // We need at least 2 entries: current state + one previous
    if (this._undoStack.length < 2) {
      return { success: false, description: 'Nothing to undo' };
    }

    // Pop current state onto redo stack
    const current = this._undoStack.pop();
    this._redoStack.push(current);

    // The new "current" is now the top of the undo stack
    const previous = this._undoStack[this._undoStack.length - 1];

    // Restore previous state
    this._restoring = true;
    try {
      restoreState(this._store, previous.snapshot);
      this._lastSnapshot = snapshotState(this._store);
    } finally {
      this._restoring = false;
    }

    return { success: true, description: previous.description };
  }

  /**
   * Redo: re-apply a previously undone state.
   * Returns { success, description }.
   */
  redo() {
    if (this._redoStack.length === 0) {
      return { success: false, description: 'Nothing to redo' };
    }

    // Pop from redo stack and push onto undo stack
    const entry = this._redoStack.pop();
    this._undoStack.push(entry);

    // Restore the entry's state
    this._restoring = true;
    try {
      restoreState(this._store, entry.snapshot);
      this._lastSnapshot = snapshotState(this._store);
    } finally {
      this._restoring = false;
    }

    return { success: true, description: entry.description };
  }

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------

  /** Can we undo? */
  canUndo() {
    return this._undoStack.length >= 2;
  }

  /** Can we redo? */
  canRedo() {
    return this._redoStack.length > 0;
  }

  /**
   * Get the history list (most recent first).
   * Returns Array<{ description, timestamp }>
   */
  getHistory() {
    return this._undoStack
      .map((entry, index) => ({
        description: entry.description,
        timestamp: entry.timestamp,
        index,
        isCurrent: index === this._undoStack.length - 1,
      }))
      .reverse();
  }

  /**
   * Clear all history.  The current state becomes the only entry.
   */
  clear() {
    const snapshot = snapshotState(this._store);
    this._undoStack = [{
      description: 'Cleared history',
      timestamp: Date.now(),
      snapshot: deepClone(snapshot),
    }];
    this._redoStack.length = 0;
    this._lastSnapshot = snapshot;
  }

  // -----------------------------------------------------------------------
  // Advanced: jump to a specific point in history
  // -----------------------------------------------------------------------

  /**
   * Jump to a specific history entry by index (0 = oldest).
   * All entries after the target are moved to the redo stack.
   * @param {number} targetIndex
   * @returns {{ success: boolean, description: string }}
   */
  jumpTo(targetIndex) {
    if (targetIndex < 0 || targetIndex >= this._undoStack.length) {
      return { success: false, description: 'Invalid history index' };
    }
    if (targetIndex === this._undoStack.length - 1) {
      return { success: false, description: 'Already at this state' };
    }

    // Move entries after target to redo stack (in correct order)
    while (this._undoStack.length - 1 > targetIndex) {
      const entry = this._undoStack.pop();
      this._redoStack.push(entry);
    }

    // Restore the target state
    const target = this._undoStack[this._undoStack.length - 1];
    this._restoring = true;
    try {
      restoreState(this._store, target.snapshot);
      this._lastSnapshot = snapshotState(this._store);
    } finally {
      this._restoring = false;
    }

    return { success: true, description: target.description };
  }

  // -----------------------------------------------------------------------
  // Memory diagnostics
  // -----------------------------------------------------------------------

  /** Return memory usage information (for debugging) */
  getMemoryInfo() {
    const undoEntries = this._undoStack.length;
    const redoEntries = this._redoStack.length;

    // Rough estimate of snapshot size
    let totalBytes = 0;
    try {
      for (const entry of this._undoStack) {
        totalBytes += JSON.stringify(entry.snapshot).length * 2; // UTF-16
      }
      for (const entry of this._redoStack) {
        totalBytes += JSON.stringify(entry.snapshot).length * 2;
      }
    } catch {
      totalBytes = -1;
    }

    return {
      undoEntries,
      redoEntries,
      maxEntries: this._maxSize,
      estimatedBytes: totalBytes,
      estimatedMB: totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(2) + ' MB' : 'unknown',
    };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Dispose the HistoryManager: unsubscribe from the store and
   * clear any pending timers.
   */
  dispose() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._lastSnapshot = null;
  }
}
