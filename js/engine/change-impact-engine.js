// Change Impact Engine — Compute diffs between current store state and an
// active baseline snapshot.  Tracks task delays, critical path changes,
// resource overload changes, and risk level changes.

/* -------------------------------------------------------------------------- */
/*  Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  try { return structuredClone(obj); } catch (_) { /* fallback */ }
  return JSON.parse(JSON.stringify(obj));
}

/** Working-day-aware date difference (end - start). Positive = current is later. */
function workingDayDiff(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  if (startStr === endStr) return 0;
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;

  const sign = end >= start ? 1 : -1;
  const from = sign === 1 ? start : end;
  const to = sign === 1 ? end : start;

  let count = 0;
  const d = new Date(from);
  while (d <= to) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return sign * count;
}

/** ISO date string helper */
function toISODate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  ChangeImpactEngine                                                         */
/* -------------------------------------------------------------------------- */

export class ChangeImpactEngine {
  /**
   * @param {import('../core/store.js').Store} store
   * @param {import('../core/baseline-manager.js').BaselineManager} baselineManager
   * @param {Object} deps
   * @param {import('../core/dependency-engine.js').DependencyEngine} deps.dependencyEngine
   * @param {import('../engine/resource-engine.js').ResourceEngine}   deps.resourceEngine
   * @param {import('../engine/risk-engine.js').RiskEngine}           deps.riskEngine
   * @param {Function} [deps.workerRequest]
   */
  constructor(store, baselineManager, deps) {
    this._store = store;
    this._baselineManager = baselineManager;
    this._depEngine = deps.dependencyEngine;
    this._resEngine = deps.resourceEngine;
    this._riskEngine = deps.riskEngine;
    this._workerRequest = deps.workerRequest || (() => Promise.resolve(null));

    this._lastDiff = null;
    this._stale = true;
    this._autoRecompute = true;
    this._debounceTimer = null;
    this._unsubscribe = null;

    // Subscribe to relevant store events
    this._unsubscribe = this._store.subscribe((event) => this._onStoreChange(event));
  }

  // -------------------------------------------------------------------------
  // Core computation
  // -------------------------------------------------------------------------

  /**
   * Compute the full diff between the active (or specified) baseline and
   * current store state.  Returns a ChangeDiff object.
   */
  computeDiff(baselineId) {
    const id = baselineId || this._store.state.activeBaselineId;
    if (!id) return null;

    const baseline = this._baselineManager.getBaseline(id);
    if (!baseline) return null;

    const currentSnapshot = deepClone(this._store.exportData());
    const baselineSnapshot = baseline.snapshot;

    // Compute current critical path
    let currentCritIds = [];
    try {
      const cp = this._depEngine.calculateCriticalPath(null);
      currentCritIds = cp.taskIds || [];
    } catch (_) { /* */ }

    const baselineCritIds = baseline.metrics.criticalPathTaskIds || [];

    // Compute all diffs
    const taskChanges = this._diffTasks(
      baselineSnapshot.tasks, currentSnapshot.tasks,
      new Set(baselineCritIds), new Set(currentCritIds)
    );

    const criticalPathDiff = this._diffCriticalPath(
      new Set(baselineCritIds), new Set(currentCritIds)
    );

    const resourceOverloadDiff = this._diffResourceOverloads(
      baselineSnapshot, currentSnapshot
    );

    const riskChanges = this._diffRiskLevels(
      baselineSnapshot.risks, currentSnapshot.risks
    );

    const diff = {
      baselineId: id,
      computedAt: Date.now(),
      storeVersion: this._store.getVersion(),
      baselineVersion: baseline.storeVersion ?? 0,
      taskChanges,
      criticalPathDiff,
      resourceOverloadDiff,
      riskChanges,
      summary: null,
    };

    diff.summary = this._buildSummary(diff);

    this._lastDiff = diff;
    this._stale = false;
    return diff;
  }

  /** Async version — dispatches to Worker for large portfolios */
  async computeDiffAsync(baselineId) {
    const id = baselineId || this._store.state.activeBaselineId;
    if (!id) return null;

    const baseline = this._baselineManager.getBaseline(id);
    if (!baseline) return null;

    const requestVersion = this._store.getVersion();
    const currentSnapshot = deepClone(this._store.exportData());
    let currentCritIds = [];
    try {
      const cp = this._depEngine.calculateCriticalPath(null);
      currentCritIds = cp.taskIds || [];
    } catch (_) { /* */ }

    const result = await this._workerRequest('compute-change-impact', {
      baselineSnapshot: baseline.snapshot,
      currentSnapshot,
      baselineCriticalPath: baseline.metrics.criticalPathTaskIds || [],
      currentCriticalPath: currentCritIds,
    });

    // Discard stale result: if the store has moved on since the request
    if (this._store.getVersion() > requestVersion) {
      return this.computeDiff(id);
    }

    if (result) {
      result.baselineId = id;
      result.computedAt = Date.now();
      result.storeVersion = requestVersion;
      result.baselineVersion = baseline.storeVersion ?? 0;
      this._lastDiff = result;
      this._stale = false;
    }

    return result || this.computeDiff(id);
  }

  // -------------------------------------------------------------------------
  // Staleness
  // -------------------------------------------------------------------------

  isStale() { return this._stale; }
  getLastDiff() { return this._lastDiff; }

  // -------------------------------------------------------------------------
  // Auto-recompute
  // -------------------------------------------------------------------------

  enableAutoRecompute() { this._autoRecompute = true; }
  disableAutoRecompute() { this._autoRecompute = false; }

  // -------------------------------------------------------------------------
  // Targeted queries (used by views)
  // -------------------------------------------------------------------------

  /** Get delay days for one task */
  getTaskDelay(taskId) {
    if (!this._lastDiff) return 0;
    const change = this._lastDiff.taskChanges.find(tc => tc.taskId === taskId);
    return change ? change.delayDays : 0;
  }

  /** Get full TaskChange record for one task */
  getTaskChange(taskId) {
    if (!this._lastDiff) return null;
    return this._lastDiff.taskChanges.find(tc => tc.taskId === taskId) || null;
  }

  /** Get Set of all changed task IDs */
  getChangedTaskIds() {
    if (!this._lastDiff) return new Set();
    return new Set(
      this._lastDiff.taskChanges
        .filter(tc => tc.delayDays !== 0 || tc.addedToCriticalPath || tc.removedFromCriticalPath || tc.isNew || tc.isDeleted)
        .map(tc => tc.taskId)
    );
  }

  /** Get critical path changes */
  getCriticalPathChanges() {
    if (!this._lastDiff) return { added: [], removed: [] };
    return this._lastDiff.criticalPathDiff;
  }

  /** Get resource overload changes */
  getResourceOverloadChanges() {
    if (!this._lastDiff) return [];
    return this._lastDiff.resourceOverloadDiff || [];
  }

  /** Get risk level changes */
  getRiskChanges() {
    if (!this._lastDiff) return [];
    return this._lastDiff.riskChanges || [];
  }

  /** Get Set of risk IDs that were upgraded */
  getUpgradedRiskIds() {
    if (!this._lastDiff) return new Set();
    return new Set(
      (this._lastDiff.riskChanges || [])
        .filter(rc => rc.direction === 'upgraded')
        .map(rc => rc.riskId)
    );
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Validate current state vs baseline — returns ValidationIssue[] */
  validateCurrentVsBaseline() {
    const issues = [];
    if (!this._lastDiff) return issues;

    const { taskChanges, summary } = this._lastDiff;

    // Flag large delays
    for (const tc of taskChanges) {
      if (tc.delayDays > 10) {
        issues.push({
          severity: 'warning',
          type: 'large-delay',
          message: `Task "${tc.taskName}" is delayed by ${tc.delayDays} days vs baseline`,
          affectedIds: [tc.taskId],
        });
      }
    }

    // Flag many critical path additions
    if (summary.criticalPathAdded > 3) {
      issues.push({
        severity: 'warning',
        type: 'cp-expansion',
        message: `${summary.criticalPathAdded} tasks added to critical path`,
        affectedIds: this._lastDiff.criticalPathDiff.added,
      });
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // Private — Diff algorithms
  // -------------------------------------------------------------------------

  _onStoreChange(event) {
    const relevantTypes = new Set(['task', 'resource', 'risk', 'batch', 'restore']);
    if (!relevantTypes.has(event.type)) return;
    if (!this._autoRecompute) return;
    if (!this._store.state.activeBaselineId) return;

    this._stale = true;

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const versionAtRequest = this._store.getVersion();
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      // Discard if the store has moved on since we scheduled this recompute
      if (this._store.getVersion() !== versionAtRequest) return;
      const diff = this.computeDiff();
      if (diff) {
        this._store.state.changeDiff = diff;
      }
    }, 300);
  }

  /** Diff tasks between baseline and current */
  _diffTasks(blTasks, curTasks, blCritSet, curCritSet) {
    const blMap = new Map(blTasks.map(t => [t.id, t]));
    const curMap = new Map(curTasks.map(t => [t.id, t]));
    const changes = [];

    // Current tasks vs baseline
    for (const [id, cur] of curMap) {
      const bl = blMap.get(id);
      const isNew = !bl;

      let delayDays = 0;
      if (!isNew && bl.plannedEnd && cur.plannedEnd) {
        delayDays = workingDayDiff(bl.plannedEnd, cur.plannedEnd);
      }

      const wasCritical = blCritSet.has(id);
      const isCritical = curCritSet.has(id);

      changes.push({
        taskId: id,
        taskName: cur.name || '',
        projectId: cur.projectId || '',
        delayDays,
        baselineStart: bl ? (bl.plannedStart || '') : '',
        baselineEnd: bl ? (bl.plannedEnd || '') : '',
        currentStart: cur.plannedStart || '',
        currentEnd: cur.plannedEnd || '',
        addedToCriticalPath: !wasCritical && isCritical,
        removedFromCriticalPath: wasCritical && !isCritical,
        wasCritical,
        isCritical,
        baselineStatus: bl ? (bl.status || '') : '',
        currentStatus: cur.status || '',
        baselineProgress: bl ? (bl.progress ?? 0) : 0,
        currentProgress: cur.progress ?? 0,
        baselineAssignee: bl ? (bl.assignee || '') : '',
        currentAssignee: cur.assignee || '',
        baselineDeps: bl ? [...(bl.dependencies || [])] : [],
        currentDeps: [...(cur.dependencies || [])],
        isNew,
        isDeleted: false,
      });
    }

    // Baseline tasks not in current (deleted)
    for (const [id, bl] of blMap) {
      if (!curMap.has(id)) {
        changes.push({
          taskId: id,
          taskName: bl.name || '',
          projectId: bl.projectId || '',
          delayDays: 0,
          baselineStart: bl.plannedStart || '',
          baselineEnd: bl.plannedEnd || '',
          currentStart: '',
          currentEnd: '',
          addedToCriticalPath: false,
          removedFromCriticalPath: blCritSet.has(id),
          wasCritical: blCritSet.has(id),
          isCritical: false,
          baselineStatus: bl.status || '',
          currentStatus: '',
          baselineProgress: bl.progress ?? 0,
          currentProgress: 0,
          baselineAssignee: bl.assignee || '',
          currentAssignee: '',
          baselineDeps: [...(bl.dependencies || [])],
          currentDeps: [],
          isNew: false,
          isDeleted: true,
        });
      }
    }

    // Sort by absolute delay descending (most impactful first)
    changes.sort((a, b) => Math.abs(b.delayDays) - Math.abs(a.delayDays));
    return changes;
  }

  /** Diff critical path sets */
  _diffCriticalPath(blSet, curSet) {
    const added = [];
    const removed = [];

    for (const id of curSet) {
      if (!blSet.has(id)) added.push(id);
    }
    for (const id of blSet) {
      if (!curSet.has(id)) removed.push(id);
    }

    return { added, removed };
  }

  /** Diff resource overloads between baseline and current snapshots */
  _diffResourceOverloads(blSnapshot, curSnapshot) {
    const diffs = [];

    // Build resource maps
    const blResMap = new Map((blSnapshot.resources || []).map(r => [r.id, r]));
    const curResMap = new Map((curSnapshot.resources || []).map(r => [r.id, r]));
    const blTaskMap = new Map((blSnapshot.tasks || []).map(t => [t.id, t]));
    const curTaskMap = new Map((curSnapshot.tasks || []).map(t => [t.id, t]));

    for (const [resId, curRes] of curResMap) {
      const blRes = blResMap.get(resId);
      if (!curRes.tasks || curRes.tasks.length === 0) continue;

      // Compute current overload dates
      const curOverloads = this._findOverloadDates(curRes, curTaskMap);
      const blOverloads = blRes ? this._findOverloadDates(blRes, blTaskMap) : new Map();

      const newOverloads = [];
      const resolvedOverloads = [];

      for (const [date, info] of curOverloads) {
        if (!blOverloads.has(date)) {
          // Find causative tasks — those whose dates shifted
          const causativeTasks = this._findCausativeTasks(
            date, curRes, curTaskMap, blTaskMap
          );
          newOverloads.push({
            date,
            totalAllocation: info.total,
            causativeTasks,
          });
        }
      }

      for (const [date, info] of blOverloads) {
        if (!curOverloads.has(date)) {
          resolvedOverloads.push({
            date,
            totalAllocation: info.total,
          });
        }
      }

      if (newOverloads.length > 0 || resolvedOverloads.length > 0) {
        diffs.push({
          resourceId: resId,
          resourceName: curRes.name || '',
          newOverloads,
          resolvedOverloads,
        });
      }
    }

    return diffs;
  }

  /** Find dates where a resource is overloaded. Returns Map<date, {total, tasks}> */
  _findOverloadDates(resource, taskMap) {
    const overloads = new Map();
    const maxCap = resource.maxCapacity || 100;

    if (!resource.tasks) return overloads;

    // Build daily allocation map
    const dayMap = new Map();
    for (const assignment of resource.tasks) {
      const task = taskMap.get(assignment.taskId);
      if (!task || !task.plannedStart || !task.plannedEnd) continue;

      const start = new Date(task.plannedStart + 'T00:00:00');
      const end = new Date(task.plannedEnd + 'T00:00:00');
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

      const alloc = assignment.allocation || 0;
      const d = new Date(start);
      while (d <= end) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) {
          const dateStr = toISODate(d);
          if (!dayMap.has(dateStr)) dayMap.set(dateStr, { total: 0, tasks: [] });
          const entry = dayMap.get(dateStr);
          entry.total += alloc;
          entry.tasks.push(assignment.taskId);
        }
        d.setDate(d.getDate() + 1);
      }
    }

    for (const [date, info] of dayMap) {
      if (info.total > maxCap) {
        overloads.set(date, info);
      }
    }

    return overloads;
  }

  /** Find tasks that caused an overload on a specific date */
  _findCausativeTasks(date, curRes, curTaskMap, blTaskMap) {
    const causative = [];
    const dateObj = new Date(date + 'T00:00:00');

    for (const assignment of (curRes.tasks || [])) {
      const curTask = curTaskMap.get(assignment.taskId);
      if (!curTask || !curTask.plannedStart || !curTask.plannedEnd) continue;

      const start = new Date(curTask.plannedStart + 'T00:00:00');
      const end = new Date(curTask.plannedEnd + 'T00:00:00');
      if (dateObj < start || dateObj > end) continue;

      // Check if this task's dates shifted from baseline
      const blTask = blTaskMap.get(assignment.taskId);
      let shiftDays = 0;
      if (blTask && blTask.plannedEnd && curTask.plannedEnd) {
        shiftDays = workingDayDiff(blTask.plannedEnd, curTask.plannedEnd);
      }

      causative.push({
        taskId: assignment.taskId,
        taskName: curTask.name || '',
        allocation: assignment.allocation || 0,
        shiftDays,
      });
    }

    return causative;
  }

  /** Diff risk levels between baseline and current */
  _diffRiskLevels(blRisks, curRisks) {
    const blMap = new Map(blRisks.map(r => [r.id, r]));
    const curMap = new Map(curRisks.map(r => [r.id, r]));
    const changes = [];

    for (const [id, cur] of curMap) {
      const bl = blMap.get(id);
      if (!bl) {
        changes.push({
          riskId: id,
          name: cur.name || '',
          oldLevel: '',
          newLevel: cur.level || 'low',
          oldScore: 0,
          newScore: (cur.probability || 1) * (cur.impact || 1),
          direction: 'new',
        });
        continue;
      }

      const oldScore = (bl.probability || 1) * (bl.impact || 1);
      const newScore = (cur.probability || 1) * (cur.impact || 1);
      const oldLevel = bl.level || this._scoreToLevel(oldScore);
      const newLevel = cur.level || this._scoreToLevel(newScore);

      let direction = 'unchanged';
      if (newScore > oldScore) direction = 'upgraded';
      else if (newScore < oldScore) direction = 'downgraded';

      if (direction !== 'unchanged') {
        changes.push({
          riskId: id,
          name: cur.name || '',
          oldLevel,
          newLevel,
          oldScore,
          newScore,
          direction,
        });
      }
    }

    // Deleted risks
    for (const [id, bl] of blMap) {
      if (!curMap.has(id)) {
        changes.push({
          riskId: id,
          name: bl.name || '',
          oldLevel: bl.level || 'low',
          newLevel: '',
          oldScore: (bl.probability || 1) * (bl.impact || 1),
          newScore: 0,
          direction: 'deleted',
        });
      }
    }

    return changes;
  }

  _scoreToLevel(score) {
    if (score >= 20) return 'critical';
    if (score >= 12) return 'high';
    if (score >= 6) return 'medium';
    return 'low';
  }

  /** Build summary from a diff object */
  _buildSummary(diff) {
    const taskChanges = diff.taskChanges || [];
    const totalTasksChanged = taskChanges.filter(
      tc => tc.delayDays !== 0 || tc.isNew || tc.isDeleted ||
            tc.addedToCriticalPath || tc.removedFromCriticalPath
    ).length;

    const totalDelayDays = taskChanges.reduce(
      (sum, tc) => sum + Math.max(0, tc.delayDays), 0
    );

    return {
      totalTasksChanged,
      totalDelayDays,
      criticalPathAdded: (diff.criticalPathDiff?.added || []).length,
      criticalPathRemoved: (diff.criticalPathDiff?.removed || []).length,
      newOverloads: (diff.resourceOverloadDiff || []).reduce(
        (sum, r) => sum + r.newOverloads.length, 0
      ),
      resolvedOverloads: (diff.resourceOverloadDiff || []).reduce(
        (sum, r) => sum + r.resolvedOverloads.length, 0
      ),
      risksUpgraded: (diff.riskChanges || []).filter(rc => rc.direction === 'upgraded').length,
      risksDowngraded: (diff.riskChanges || []).filter(rc => rc.direction === 'downgraded').length,
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
  }
}
