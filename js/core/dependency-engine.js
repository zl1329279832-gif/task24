/**
 * dependency-engine.js
 * Dependency graph analysis and scheduling calculations for
 * multi-project portfolio management.
 *
 * Algorithms:
 *  - Critical Path Method (CPM): forward/backward pass
 *  - Circular dependency detection: DFS with tri-colour marking
 *  - Date propagation: BFS through successor graph
 *  - Slack calculation: free slack & total slack per task
 */

import { Store } from './store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Date helpers (pure functions for performance)
// ---------------------------------------------------------------------------

/** Parse a date string or Date to epoch-ms; returns NaN for invalid */
function toDateMs(d) {
  if (!d) return NaN;
  if (typeof d === 'number') return d;
  if (d instanceof Date) return d.getTime();
  const ms = new Date(d).getTime();
  return ms;
}

/** Format epoch-ms -> YYYY-MM-DD string */
function msToDateStr(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

/** Add `days` calendar days to an epoch-ms timestamp */
function addDays(ms, days) {
  return ms + days * DAY_MS;
}

/** Difference in calendar days between two timestamps */
function diffDays(a, b) {
  return Math.round((b - a) / DAY_MS);
}

// ---------------------------------------------------------------------------
// DependencyEngine
// ---------------------------------------------------------------------------

export class DependencyEngine {
  /**
   * @param {Store} store - the central data store
   */
  constructor(store) {
    if (!(store instanceof Store)) {
      throw new TypeError('DependencyEngine requires a Store instance');
    }
    this._store = store;

    /** @type {Map<string, {taskIds: string[], totalDuration: number}>} */
    this._criticalPathCache = new Map();
    /** @type {Map<string, Map<string, {freeSlack: number, totalSlack: number}>>} */
    this._slackCache = new Map();

    /** Store version at which caches were last computed */
    this._cacheVersion = -1;

    // Invalidate cache on any task mutation or full state restore
    this._store.subscribe((event) => {
      if (['task', 'batch', 'restore'].includes(event.type)) {
        this._invalidateCache();
      }
    });
  }

  _invalidateCache() {
    this._cacheVersion = -1;
    this._criticalPathCache.clear();
    this._slackCache.clear();
  }

  /** Check if caches are stale by comparing store version */
  _ensureCacheValid() {
    const currentVersion = this._store.getVersion();
    if (this._cacheVersion !== currentVersion) {
      this._criticalPathCache.clear();
      this._slackCache.clear();
      this._cacheVersion = currentVersion;
    }
  }

  // -----------------------------------------------------------------------
  // Graph construction
  // -----------------------------------------------------------------------

  /**
   * Build a dependency adjacency list for the given tasks.
   * Map<taskId, Set<successorTaskId>> -- edges point from predecessor to successor.
   */
  buildDependencyGraph(tasks) {
    const graph = new Map();
    const taskIds = new Set(tasks.map(t => t.id));

    for (const t of tasks) {
      if (!graph.has(t.id)) graph.set(t.id, new Set());
    }

    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (taskIds.has(depId)) {
          if (!graph.has(depId)) graph.set(depId, new Set());
          graph.get(depId).add(t.id); // dep -> t (successor)
        }
      }
    }

    return graph;
  }

  /** Build a reverse adjacency list: Map<taskId, Set<predecessorTaskId>> */
  _buildReverseGraph(tasks) {
    const rev = new Map();
    for (const t of tasks) {
      if (!rev.has(t.id)) rev.set(t.id, new Set());
      for (const depId of (t.dependencies || [])) {
        rev.get(t.id).add(depId);
      }
    }
    return rev;
  }

  /**
   * Gather all tasks relevant to a calculation.
   * If projectId is given, include that project's tasks + any cross-project deps.
   */
  _getRelevantTasks(projectId) {
    if (!projectId) {
      return Array.from(this._store.state.tasks.values());
    }

    const tasks = this._store.getProjectTasks(projectId);
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Also include tasks referenced via cross-project deps
    for (const t of tasks) {
      for (const cpd of (t.crossProjectDeps || [])) {
        if (!taskMap.has(cpd.taskId)) {
          const otherTask = this._store.state.tasks.get(cpd.taskId);
          if (otherTask) taskMap.set(otherTask.id, otherTask);
        }
      }
    }

    return Array.from(taskMap.values());
  }

  // -----------------------------------------------------------------------
  // Topological sort (Kahn's algorithm)
  // -----------------------------------------------------------------------

  /**
   * Topological sort of tasks respecting dependencies.
   * Returns tasks in execution order.  If a cycle exists, the involved
   * tasks are omitted (call detectCircularDependencies for details).
   */
  topologicalSort(tasks) {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const inDegree = new Map();
    const adj = new Map();

    for (const t of tasks) {
      inDegree.set(t.id, 0);
      adj.set(t.id, new Set());
    }

    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (taskMap.has(depId)) {
          adj.get(depId).add(t.id);
          inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
        }
      }
      // Cross-project deps
      for (const cpd of (t.crossProjectDeps || [])) {
        if (taskMap.has(cpd.taskId)) {
          adj.get(cpd.taskId).add(t.id);
          inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
        }
      }
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted = [];
    while (queue.length > 0) {
      const id = queue.shift();
      sorted.push(taskMap.get(id));
      for (const succ of (adj.get(id) || [])) {
        const newDeg = inDegree.get(succ) - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) queue.push(succ);
      }
    }

    // Tasks not in sorted are part of cycles -- include them at the end
    if (sorted.length < tasks.length) {
      const sortedIds = new Set(sorted.map(t => t.id));
      for (const t of tasks) {
        if (!sortedIds.has(t.id)) sorted.push(t);
      }
    }

    return sorted;
  }

  // -----------------------------------------------------------------------
  // Circular dependency detection (DFS tri-colour)
  // -----------------------------------------------------------------------

  /**
   * Detect all circular dependencies in the full task set.
   * Uses DFS with white/gray/black colouring.
   * Returns [{ cycle: string[], description: string }]
   */
  detectCircularDependencies() {
    const allTasks = Array.from(this._store.state.tasks.values());
    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    // Build adjacency: task -> [dependencies it waits for]
    // For cycle detection, edge direction is task -> dependency
    // A cycle in this graph means circular dependency.
    const adj = new Map();
    for (const t of allTasks) {
      const waitsFor = [];
      for (const depId of (t.dependencies || [])) {
        if (taskMap.has(depId)) waitsFor.push(depId);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (taskMap.has(cpd.taskId)) waitsFor.push(cpd.taskId);
      }
      adj.set(t.id, waitsFor);
    }

    // Tri-colour DFS: 0=white, 1=gray, 2=black
    const color = new Map();
    for (const id of taskMap.keys()) color.set(id, 0);

    const cycles = [];

    const dfs = (nodeId, path) => {
      color.set(nodeId, 1); // gray -- currently being explored
      path.push(nodeId);

      for (const next of (adj.get(nodeId) || [])) {
        if (color.get(next) === 1) {
          // Back edge -> cycle found
          const cycleStart = path.indexOf(next);
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart);
            const names = cycle.map(id => {
              const t = taskMap.get(id);
              return t ? `${t.name} (${id})` : id;
            });
            cycles.push({
              cycle: [...cycle],
              description: `Circular dependency detected: ${names.join(' -> ')} -> ${names[0]}`,
            });
          }
        } else if (color.get(next) === 0) {
          dfs(next, path);
        }
      }

      path.pop();
      color.set(nodeId, 2); // black -- fully explored
    };

    for (const id of taskMap.keys()) {
      if (color.get(id) === 0) {
        dfs(id, []);
      }
    }

    return cycles;
  }

  // -----------------------------------------------------------------------
  // Critical Path Method (forward + backward pass)
  // -----------------------------------------------------------------------

  /**
   * Calculate the critical path for a project (or all projects).
   * Returns { taskIds: string[], totalDuration: number }
   */
  calculateCriticalPath(projectId) {
    // Check cache
    this._ensureCacheValid();
    const cacheKey = projectId || '__all__';
    if (this._criticalPathCache.has(cacheKey)) {
      return this._criticalPathCache.get(cacheKey);
    }

    const tasks = this._getRelevantTasks(projectId);
    if (tasks.length === 0) return { taskIds: [], totalDuration: 0 };

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted = this.topologicalSort(tasks);

    // ---- Forward pass: calculate Early Start (ES) and Early Finish (EF) ----
    const ES = new Map(); // taskId -> epoch-ms
    const EF = new Map();

    for (const t of sorted) {
      const start = toDateMs(t.plannedStart);
      const end = toDateMs(t.plannedEnd);
      const duration = Number.isFinite(start) && Number.isFinite(end)
        ? diffDays(start, end)
        : (t.estimatedDays || 1);

      // ES = max(EF of all predecessors)
      let earliestStart = Number.isFinite(start) ? start : Date.now();
      for (const depId of (t.dependencies || [])) {
        if (EF.has(depId) && EF.get(depId) > earliestStart) {
          earliestStart = EF.get(depId);
        }
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (EF.has(cpd.taskId) && EF.get(cpd.taskId) > earliestStart) {
          earliestStart = EF.get(cpd.taskId);
        }
      }

      ES.set(t.id, earliestStart);
      EF.set(t.id, addDays(earliestStart, duration));
    }

    // ---- Backward pass: calculate Late Finish (LF) and Late Start (LS) ----
    const maxEF = Math.max(...EF.values(), Date.now());
    const LF = new Map();
    const LS = new Map();

    // Build successor map
    const successors = new Map();
    for (const t of tasks) {
      successors.set(t.id, []);
    }
    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (successors.has(depId)) successors.get(depId).push(t.id);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (successors.has(cpd.taskId)) successors.get(cpd.taskId).push(t.id);
      }
    }

    // Process in reverse topological order
    for (let i = sorted.length - 1; i >= 0; i--) {
      const t = sorted[i];
      const start = ES.get(t.id);
      const end = EF.get(t.id);
      const duration = diffDays(start, end);

      // LF = min(LS of all successors)
      let latestFinish = maxEF;
      for (const succId of (successors.get(t.id) || [])) {
        if (LS.has(succId) && LS.get(succId) < latestFinish) {
          latestFinish = LS.get(succId);
        }
      }

      LF.set(t.id, latestFinish);
      LS.set(t.id, addDays(latestFinish, -duration));
    }

    // ---- Identify critical tasks (total slack ~ 0) ----
    const criticalIds = [];
    const SLACK_THRESHOLD = DAY_MS; // allow 1 day tolerance

    for (const t of sorted) {
      const totalSlack = (LF.get(t.id) || 0) - (EF.get(t.id) || 0);
      if (Math.abs(totalSlack) <= SLACK_THRESHOLD) {
        criticalIds.push(t.id);
      }
    }

    // Total duration of the critical path
    const totalDuration = criticalIds.length > 0
      ? diffDays(
          Math.min(...criticalIds.map(id => ES.get(id) || 0)),
          Math.max(...criticalIds.map(id => EF.get(id) || 0))
        )
      : 0;

    const result = { taskIds: criticalIds, totalDuration };
    this._criticalPathCache.set(cacheKey, result);
    return result;
  }

  /**
   * Calculate all paths through the dependency graph.
   * Returns Array<{ taskIds: string[], duration: number, isCritical: boolean }>
   */
  calculateAllPaths(projectId) {
    const tasks = this._getRelevantTasks(projectId);
    if (tasks.length === 0) return [];

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted = this.topologicalSort(tasks);

    // Build successor map
    const successors = new Map();
    for (const t of tasks) {
      successors.set(t.id, []);
    }
    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (taskMap.has(depId) && successors.has(depId)) {
          successors.get(depId).push(t.id);
        }
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (taskMap.has(cpd.taskId) && successors.has(cpd.taskId)) {
          successors.get(cpd.taskId).push(t.id);
        }
      }
    }

    // Find root tasks (no predecessors)
    const hasPredecessor = new Set();
    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (taskMap.has(depId)) hasPredecessor.add(t.id);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (taskMap.has(cpd.taskId)) hasPredecessor.add(t.id);
      }
    }
    const roots = tasks.filter(t => !hasPredecessor.has(t.id));

    // DFS to enumerate all paths
    const paths = [];
    const taskDuration = (t) => {
      const s = toDateMs(t.plannedStart);
      const e = toDateMs(t.plannedEnd);
      return (Number.isFinite(s) && Number.isFinite(e)) ? diffDays(s, e) : (t.estimatedDays || 1);
    };

    const dfs = (nodeId, pathIds, pathDuration) => {
      const succs = successors.get(nodeId) || [];
      if (succs.length === 0) {
        // Leaf node -- record the path
        paths.push({ taskIds: [...pathIds], duration: pathDuration, isCritical: false });
        return;
      }
      for (const succId of succs) {
        const succTask = taskMap.get(succId);
        if (!succTask) continue;
        pathIds.push(succId);
        dfs(succId, pathIds, pathDuration + taskDuration(succTask));
        pathIds.pop();
      }
    };

    for (const root of roots) {
      dfs(root.id, [root.id], taskDuration(root));
    }

    // Mark the longest path(s) as critical
    if (paths.length > 0) {
      const maxDuration = Math.max(...paths.map(p => p.duration));
      for (const p of paths) {
        if (p.duration === maxDuration) p.isCritical = true;
      }
    }

    return paths;
  }

  // -----------------------------------------------------------------------
  // Change propagation (BFS through successors)
  // -----------------------------------------------------------------------

  /**
   * Propagate date changes from a single task through its successors.
   * Successors are pushed forward so that successor.start >= predecessor.end + 1 day.
   * Returns affected tasks with old and new dates.
   */
  propagateChanges(changedTaskId, newStart, newEnd) {
    const changedTask = this._store.state.tasks.get(changedTaskId);
    if (!changedTask) return { affectedTasks: [] };

    const allTasks = Array.from(this._store.state.tasks.values());
    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    // Build successor map (including cross-project)
    const successors = new Map();
    for (const t of allTasks) {
      if (!successors.has(t.id)) successors.set(t.id, []);
    }
    for (const t of allTasks) {
      for (const depId of (t.dependencies || [])) {
        if (successors.has(depId)) successors.get(depId).push(t.id);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (successors.has(cpd.taskId)) successors.get(cpd.taskId).push(t.id);
      }
    }

    // Detect cycles first to prevent infinite loops
    const cycles = this.detectCircularDependencies();
    const cycleTaskIds = new Set();
    for (const c of cycles) {
      for (const id of c.cycle) cycleTaskIds.add(id);
    }

    const affected = [];
    const visited = new Set();

    // BFS
    const queue = [changedTaskId];
    visited.add(changedTaskId);

    // The end date of the changed task determines successor starts
    let sourceEnd = newEnd
      ? toDateMs(newEnd)
      : toDateMs(changedTask.plannedEnd);

    if (Number.isNaN(sourceEnd)) return { affectedTasks: [] };

    while (queue.length > 0) {
      const currentId = queue.shift();
      const currentEnd = currentId === changedTaskId
        ? sourceEnd
        : toDateMs(taskMap.get(currentId)?.plannedEnd);

      if (Number.isNaN(currentEnd)) continue;

      for (const succId of (successors.get(currentId) || [])) {
        if (visited.has(succId)) continue;
        if (cycleTaskIds.has(succId)) continue; // skip tasks in cycles
        visited.add(succId);

        const succ = taskMap.get(succId);
        if (!succ) continue;

        const succStart = toDateMs(succ.plannedStart);
        const succEnd = toDateMs(succ.plannedEnd);
        const minStart = addDays(currentEnd, 1); // successor must start after predecessor ends

        if (Number.isFinite(succStart) && succStart < minStart) {
          // Need to push this successor forward
          const duration = Number.isFinite(succEnd)
            ? diffDays(succStart, succEnd)
            : (succ.estimatedDays || 1);
          const newSuccStart = minStart;
          const newSuccEnd = addDays(newSuccStart, duration);

          affected.push({
            id: succId,
            oldStart: succ.plannedStart,
            oldEnd: succ.plannedEnd,
            newStart: msToDateStr(newSuccStart),
            newEnd: msToDateStr(newSuccEnd),
          });

          // Update in our local map so downstream propagation uses new dates
          const updatedTask = {
            ...succ,
            plannedStart: msToDateStr(newSuccStart),
            plannedEnd: msToDateStr(newSuccEnd),
          };
          taskMap.set(succId, updatedTask);

          queue.push(succId);
        }
      }
    }

    return { affectedTasks: affected };
  }

  // -----------------------------------------------------------------------
  // Dependency analysis
  // -----------------------------------------------------------------------

  /** Get all direct predecessors of a task */
  getPredecessors(taskId) {
    const task = this._store.state.tasks.get(taskId);
    if (!task) return [];
    const ids = [...(task.dependencies || [])];
    for (const cpd of (task.crossProjectDeps || [])) {
      if (cpd.taskId) ids.push(cpd.taskId);
    }
    return ids
      .map(id => this._store.state.tasks.get(id))
      .filter(Boolean)
      .map(t => ({ ...t })); // shallow clone for safety
  }

  /** Get all direct successors of a task */
  getSuccessors(taskId) {
    const allTasks = Array.from(this._store.state.tasks.values());
    return allTasks
      .filter(t =>
        (t.dependencies || []).includes(taskId) ||
        (t.crossProjectDeps || []).some(cpd => cpd.taskId === taskId)
      )
      .map(t => ({ ...t }));
  }

  /** Get all cross-project dependencies with full context */
  getCrossProjectDeps() {
    const results = [];
    for (const t of this._store.state.tasks.values()) {
      for (const cpd of (t.crossProjectDeps || [])) {
        const fromTask = this._store.state.tasks.get(cpd.taskId);
        const toTask = t;
        if (!fromTask) continue;
        const fromProject = this._store.state.projects.get(fromTask.projectId);
        const toProject = this._store.state.projects.get(toTask.projectId);
        if (fromTask.projectId === toTask.projectId) continue; // not truly cross-project
        results.push({
          fromTask: { ...fromTask },
          toTask: { ...toTask },
          fromProject: fromProject ? { ...fromProject } : null,
          toProject: toProject ? { ...toProject } : null,
        });
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Slack calculation
  // -----------------------------------------------------------------------

  /**
   * Calculate free slack and total slack for every task.
   * Returns Map<taskId, { freeSlack: number, totalSlack: number }>
   * (values in calendar days)
   */
  calculateSlack(projectId) {
    this._ensureCacheValid();
    const cacheKey = projectId || '__all__';
    if (this._slackCache.has(cacheKey)) return this._slackCache.get(cacheKey);

    const tasks = this._getRelevantTasks(projectId);
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted = this.topologicalSort(tasks);
    const slackMap = new Map();

    if (sorted.length === 0) {
      this._slackCache.set(cacheKey, slackMap);
      return slackMap;
    }

    // Forward pass for ES/EF
    const ES = new Map();
    const EF = new Map();
    for (const t of sorted) {
      const start = toDateMs(t.plannedStart);
      const end = toDateMs(t.plannedEnd);
      const duration = Number.isFinite(start) && Number.isFinite(end)
        ? diffDays(start, end) : (t.estimatedDays || 1);

      let es = Number.isFinite(start) ? start : Date.now();
      for (const depId of (t.dependencies || [])) {
        if (EF.has(depId) && EF.get(depId) > es) es = EF.get(depId);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (EF.has(cpd.taskId) && EF.get(cpd.taskId) > es) es = EF.get(cpd.taskId);
      }
      ES.set(t.id, es);
      EF.set(t.id, addDays(es, duration));
    }

    // Backward pass for LS/LF
    const maxEF = Math.max(...EF.values(), Date.now());
    const LF = new Map();
    const LS = new Map();

    const successors = new Map();
    for (const t of tasks) successors.set(t.id, []);
    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (successors.has(depId)) successors.get(depId).push(t.id);
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (successors.has(cpd.taskId)) successors.get(cpd.taskId).push(t.id);
      }
    }

    for (let i = sorted.length - 1; i >= 0; i--) {
      const t = sorted[i];
      const duration = diffDays(ES.get(t.id), EF.get(t.id));
      let lf = maxEF;
      for (const succId of (successors.get(t.id) || [])) {
        if (LS.has(succId) && LS.get(succId) < lf) lf = LS.get(succId);
      }
      LF.set(t.id, lf);
      LS.set(t.id, addDays(lf, -duration));
    }

    // Calculate slack
    for (const t of sorted) {
      const totalSlack = diffDays(EF.get(t.id), LF.get(t.id));

      // Free slack = min(ES of successors) - EF of this task
      let freeSlack = totalSlack; // default if no successors
      const succs = successors.get(t.id) || [];
      if (succs.length > 0) {
        let minSuccES = Infinity;
        for (const sid of succs) {
          const ses = ES.get(sid);
          if (ses !== undefined && ses < minSuccES) minSuccES = ses;
        }
        if (minSuccES !== Infinity) {
          freeSlack = diffDays(EF.get(t.id), minSuccES);
        }
      }

      slackMap.set(t.id, {
        freeSlack: Math.max(0, freeSlack),
        totalSlack: Math.max(0, totalSlack),
      });
    }

    this._slackCache.set(cacheKey, slackMap);
    return slackMap;
  }

  /**
   * Calculate how many days a task is delayed relative to its planned end.
   * Returns 0 if not delayed or if no planned end is set.
   */
  calculateDelay(taskId) {
    const task = this._store.state.tasks.get(taskId);
    if (!task || task.status === 'completed') return 0;

    const plannedEnd = toDateMs(task.plannedEnd);
    if (Number.isNaN(plannedEnd)) return 0;

    const referenceDate = task.actualEnd ? toDateMs(task.actualEnd) : Date.now();
    const delay = diffDays(plannedEnd, referenceDate);
    return Math.max(0, delay);
  }

  // -----------------------------------------------------------------------
  // Critical tasks (union of zero-slack tasks)
  // -----------------------------------------------------------------------

  /** Return the set of task IDs that are on the critical path */
  findCriticalTasks(projectId) {
    const cp = this.calculateCriticalPath(projectId);
    return new Set(cp.taskIds);
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  /**
   * Validate all dependencies and return an array of issues.
   * Each issue: { type: string, message: string, tasks: string[] }
   */
  validateDependencies() {
    const issues = [];
    const allTasks = Array.from(this._store.state.tasks.values());
    const taskIds = new Set(allTasks.map(t => t.id));

    // 1. Check for dangling dependency references
    for (const t of allTasks) {
      for (const depId of (t.dependencies || [])) {
        if (!taskIds.has(depId)) {
          issues.push({
            type: 'dangling-ref',
            message: `Task "${t.name}" depends on unknown task ID "${depId}"`,
            tasks: [t.id, depId],
          });
        }
        if (depId === t.id) {
          issues.push({
            type: 'self-ref',
            message: `Task "${t.name}" depends on itself`,
            tasks: [t.id],
          });
        }
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (!taskIds.has(cpd.taskId)) {
          issues.push({
            type: 'dangling-cross-ref',
            message: `Task "${t.name}" has cross-project dep on unknown task "${cpd.taskId}"`,
            tasks: [t.id, cpd.taskId],
          });
        }
      }
    }

    // 2. Check for circular dependencies
    const cycles = this.detectCircularDependencies();
    for (const c of cycles) {
      issues.push({
        type: 'cycle',
        message: c.description,
        tasks: c.cycle,
      });
    }

    // 3. Check for date violations (successor starts before predecessor ends)
    for (const t of allTasks) {
      const tStart = toDateMs(t.plannedStart);
      if (Number.isNaN(tStart)) continue;
      for (const depId of (t.dependencies || [])) {
        const dep = this._store.state.tasks.get(depId);
        if (!dep) continue;
        const depEnd = toDateMs(dep.plannedEnd);
        if (Number.isFinite(depEnd) && tStart < depEnd) {
          issues.push({
            type: 'date-violation',
            message: `Task "${t.name}" starts before predecessor "${dep.name}" ends`,
            tasks: [t.id, depId],
          });
        }
      }
    }

    // 4. Check for tasks without planned dates
    for (const t of allTasks) {
      if (!t.plannedStart || !t.plannedEnd) {
        issues.push({
          type: 'missing-dates',
          message: `Task "${t.name}" is missing planned start or end date`,
          tasks: [t.id],
        });
      }
    }

    return issues;
  }
}
