/**
 * change-impact-engine.js
 * Computes the impact of changes by comparing the current store state
 * against a baseline snapshot.
 *
 * Produces structured diffs covering task delays, critical path changes,
 * resource overload changes, and risk level changes.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 0;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

function riskLevel(prob, impact) {
  const s = (prob || 3) * (impact || 3);
  if (s >= 20) return 'critical';
  if (s >= 12) return 'high';
  if (s >= 6) return 'medium';
  return 'low';
}

const RISK_LEVEL_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// ChangeImpactEngine
// ---------------------------------------------------------------------------

export class ChangeImpactEngine {
  /**
   * @param {import('../core/store.js').Store} store
   * @param {import('../core/dependency-engine.js').DependencyEngine} dependencyEngine
   * @param {import('./resource-engine.js').ResourceEngine} resourceEngine
   * @param {import('./risk-engine.js').RiskEngine} riskEngine
   */
  constructor(store, dependencyEngine, resourceEngine, riskEngine) {
    this._store = store;
    this._depEngine = dependencyEngine;
    this._resEngine = resourceEngine;
    this._riskEngine = riskEngine;
  }

  /**
   * Calculate the full impact of changes relative to a baseline snapshot.
   * @param {{projects, tasks, risks, resources}} baselineSnapshot
   * @returns {ImpactResult}
   */
  calculateImpact(baselineSnapshot) {
    if (!baselineSnapshot) {
      return this._emptyResult();
    }

    const currentSnapshot = this._store.getSnapshot();

    const taskDelays = this._computeTaskDelays(
      baselineSnapshot.tasks || [],
      currentSnapshot.tasks || [],
      baselineSnapshot.projects || [],
      currentSnapshot.projects || [],
    );

    const criticalPathChanges = this._computeCriticalPathDiff(
      baselineSnapshot,
      currentSnapshot,
    );

    const resourceOverloadChanges = this._computeResourceDiff(
      baselineSnapshot,
      currentSnapshot,
    );

    const riskLevelChanges = this._computeRiskDiff(
      baselineSnapshot.risks || [],
      currentSnapshot.risks || [],
      currentSnapshot.projects || [],
    );

    const summary = this._buildSummary(
      taskDelays,
      criticalPathChanges,
      resourceOverloadChanges,
      riskLevelChanges,
    );

    return {
      taskDelays,
      criticalPathChanges,
      resourceOverloadChanges,
      riskLevelChanges,
      summary,
    };
  }

  // -----------------------------------------------------------------------
  // Task delay computation
  // -----------------------------------------------------------------------

  _computeTaskDelays(baselineTasks, currentTasks, baselineProjects, currentProjects) {
    const baseMap = new Map();
    for (const t of baselineTasks) baseMap.set(t.id, t);

    const curMap = new Map();
    for (const t of currentTasks) curMap.set(t.id, t);

    const projMap = new Map();
    for (const p of currentProjects) projMap.set(p.id, p);
    for (const p of baselineProjects) {
      if (!projMap.has(p.id)) projMap.set(p.id, p);
    }

    const delays = [];

    // Tasks in current state
    for (const [id, cur] of curMap) {
      const base = baseMap.get(id);
      if (base) {
        const delayDays = daysBetween(base.plannedEnd, cur.plannedEnd);
        delays.push({
          taskId: id,
          taskName: cur.name,
          projectId: cur.projectId,
          projectName: projMap.get(cur.projectId)?.name || '',
          baselineStart: base.plannedStart,
          baselineEnd: base.plannedEnd,
          currentStart: cur.plannedStart,
          currentEnd: cur.plannedEnd,
          delayDays,
          isNew: false,
          isRemoved: false,
        });
      } else {
        // New task not in baseline
        delays.push({
          taskId: id,
          taskName: cur.name,
          projectId: cur.projectId,
          projectName: projMap.get(cur.projectId)?.name || '',
          baselineStart: null,
          baselineEnd: null,
          currentStart: cur.plannedStart,
          currentEnd: cur.plannedEnd,
          delayDays: 0,
          isNew: true,
          isRemoved: false,
        });
      }
    }

    // Tasks removed since baseline
    for (const [id, base] of baseMap) {
      if (!curMap.has(id)) {
        delays.push({
          taskId: id,
          taskName: base.name,
          projectId: base.projectId,
          projectName: projMap.get(base.projectId)?.name || '',
          baselineStart: base.plannedStart,
          baselineEnd: base.plannedEnd,
          currentStart: null,
          currentEnd: null,
          delayDays: 0,
          isNew: false,
          isRemoved: true,
        });
      }
    }

    return delays;
  }

  // -----------------------------------------------------------------------
  // Critical path diff
  // -----------------------------------------------------------------------

  _computeCriticalPathDiff(baselineSnapshot, currentSnapshot) {
    // Compute critical path for baseline tasks
    const baselineCritical = this._computeCPFromTasks(baselineSnapshot.tasks || []);
    // Current critical path from engine (already cached)
    const currentCritical = this._getCurrentCriticalIds();

    const baseSet = new Set(baselineCritical);
    const curSet = new Set(currentCritical);

    const added = currentCritical.filter(id => !baseSet.has(id));
    const removed = baselineCritical.filter(id => !curSet.has(id));

    // Estimate path length delta
    const baselineLength = this._estimatePathLength(baselineSnapshot.tasks || [], baselineCritical);
    const currentLength = this._estimatePathLength(currentSnapshot.tasks || [], currentCritical);

    return {
      baselineCritical,
      currentCritical,
      added,
      removed,
      baselinePathLength: baselineLength,
      currentPathLength: currentLength,
      pathLengthDelta: currentLength - baselineLength,
    };
  }

  _computeCPFromTasks(tasks) {
    if (!tasks.length) return [];

    // Build adjacency
    const taskMap = {};
    const successors = {};
    const predecessors = {};

    for (const t of tasks) {
      taskMap[t.id] = t;
      successors[t.id] = [];
      predecessors[t.id] = [];
    }

    for (const t of tasks) {
      const deps = (t.dependencies || []).concat(
        (t.crossProjectDeps || []).map(d => d.taskId)
      );
      for (const depId of deps) {
        if (taskMap[depId]) {
          if (!predecessors[t.id].includes(depId)) predecessors[t.id].push(depId);
          if (!successors[depId].includes(t.id)) successors[depId].push(t.id);
        }
      }
    }

    // Durations
    const durations = {};
    for (const t of tasks) {
      if (t.estimatedDays > 0) {
        durations[t.id] = t.estimatedDays;
      } else if (t.plannedStart && t.plannedEnd) {
        durations[t.id] = Math.max(1, Math.round(daysBetween(t.plannedStart, t.plannedEnd)));
      } else {
        durations[t.id] = 1;
      }
    }

    // Topological sort (Kahn's)
    const inDegree = {};
    for (const t of tasks) inDegree[t.id] = predecessors[t.id].length;
    const queue = tasks.filter(t => inDegree[t.id] === 0).map(t => t.id);
    const topoOrder = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      topoOrder.push(cur);
      for (const s of (successors[cur] || [])) {
        inDegree[s]--;
        if (inDegree[s] === 0) queue.push(s);
      }
    }
    // Append cycle participants
    for (const t of tasks) {
      if (!topoOrder.includes(t.id)) topoOrder.push(t.id);
    }

    // Forward pass
    const ES = {}, EF = {};
    for (const tid of topoOrder) {
      let maxPredEF = 0;
      for (const p of (predecessors[tid] || [])) {
        if ((EF[p] || 0) > maxPredEF) maxPredEF = EF[p];
      }
      ES[tid] = maxPredEF;
      EF[tid] = maxPredEF + durations[tid];
    }

    const projectDuration = Math.max(...Object.values(EF), 0);

    // Backward pass
    const LF = {}, LS = {};
    for (let i = topoOrder.length - 1; i >= 0; i--) {
      const tid = topoOrder[i];
      let minSuccLS = projectDuration;
      for (const s of (successors[tid] || [])) {
        if ((LS[s] ?? projectDuration) < minSuccLS) minSuccLS = LS[s];
      }
      LF[tid] = minSuccLS;
      LS[tid] = minSuccLS - durations[tid];
    }

    // Critical = zero float
    return tasks.filter(t => Math.abs((LS[t.id] || 0) - (ES[t.id] || 0)) < 0.01).map(t => t.id);
  }

  _getCurrentCriticalIds() {
    const ids = [];
    try {
      const projects = Array.from(this._store.state.projects.values());
      for (const p of projects) {
        const cp = this._depEngine.calculateCriticalPath(p.id);
        if (cp && cp.taskIds) ids.push(...cp.taskIds);
      }
    } catch { /* ignore */ }
    return [...new Set(ids)];
  }

  _estimatePathLength(tasks, criticalIds) {
    const critSet = new Set(criticalIds);
    let total = 0;
    for (const t of tasks) {
      if (!critSet.has(t.id)) continue;
      if (t.estimatedDays > 0) {
        total += t.estimatedDays;
      } else if (t.plannedStart && t.plannedEnd) {
        total += Math.max(1, daysBetween(t.plannedStart, t.plannedEnd));
      } else {
        total += 1;
      }
    }
    return total;
  }

  // -----------------------------------------------------------------------
  // Resource overload diff
  // -----------------------------------------------------------------------

  _computeResourceDiff(baselineSnapshot, currentSnapshot) {
    const baseResources = baselineSnapshot.resources || [];
    const curResources = currentSnapshot.resources || [];
    const baseTaskMap = new Map((baselineSnapshot.tasks || []).map(t => [t.id, t]));
    const curTaskMap = new Map((currentSnapshot.tasks || []).map(t => [t.id, t]));
    const projMap = new Map((currentSnapshot.projects || []).map(p => [p.id, p]));

    const baseResMap = new Map(baseResources.map(r => [r.id, r]));
    const curResMap = new Map(curResources.map(r => [r.id, r]));

    const allResIds = new Set([...baseResMap.keys(), ...curResMap.keys()]);
    const changes = [];

    for (const resId of allResIds) {
      const baseRes = baseResMap.get(resId);
      const curRes = curResMap.get(resId);

      const basePeak = baseRes ? this._peakLoad(baseRes, baseTaskMap) : 0;
      const curPeak = curRes ? this._peakLoad(curRes, curTaskMap) : 0;
      const baseCap = baseRes?.maxCapacity || 100;
      const curCap = curRes?.maxCapacity || 100;

      const baseOverloaded = basePeak > baseCap;
      const curOverloaded = curPeak > curCap;

      // Compute overload sources for current state
      const overloadSources = [];
      if (curRes && curOverloaded) {
        for (const rt of (curRes.tasks || [])) {
          const task = curTaskMap.get(rt.taskId);
          const proj = projMap.get(rt.projectId);
          overloadSources.push({
            taskId: rt.taskId,
            taskName: task?.name || '',
            projectName: proj?.name || '',
            allocation: rt.allocation,
          });
        }
        overloadSources.sort((a, b) => b.allocation - a.allocation);
      }

      changes.push({
        resourceId: resId,
        resourceName: (curRes || baseRes)?.name || '',
        baselineOverloaded: baseOverloaded,
        currentOverloaded: curOverloaded,
        baselinePeakLoad: basePeak,
        currentPeakLoad: curPeak,
        baselineCapacity: baseCap,
        currentCapacity: curCap,
        overloadSources,
        isNew: !baseRes,
        isRemoved: !curRes,
      });
    }

    return changes;
  }

  _peakLoad(resource, taskMap) {
    // Simple peak: sum of all allocations for overlapping tasks
    // More accurate would use sweep-line, but sum is a good proxy
    const totalAlloc = (resource.tasks || []).reduce((sum, rt) => {
      const task = taskMap.get(rt.taskId);
      if (!task || task.status === 'completed') return sum;
      return sum + (rt.allocation || 0);
    }, 0);
    return totalAlloc;
  }

  // -----------------------------------------------------------------------
  // Risk level diff
  // -----------------------------------------------------------------------

  _computeRiskDiff(baselineRisks, currentRisks, currentProjects) {
    const baseMap = new Map(baselineRisks.map(r => [r.id, r]));
    const curMap = new Map(currentRisks.map(r => [r.id, r]));
    const projMap = new Map(currentProjects.map(p => [p.id, p]));

    const allRiskIds = new Set([...baseMap.keys(), ...curMap.keys()]);
    const changes = [];

    for (const riskId of allRiskIds) {
      const base = baseMap.get(riskId);
      const cur = curMap.get(riskId);

      if (base && cur) {
        const baseLevel = base.level || riskLevel(base.probability, base.impact);
        const curLevel = cur.level || riskLevel(cur.probability, cur.impact);
        const bIdx = RISK_LEVEL_ORDER[baseLevel] ?? 0;
        const cIdx = RISK_LEVEL_ORDER[curLevel] ?? 0;

        changes.push({
          riskId,
          riskName: cur.name,
          projectId: cur.projectId,
          projectName: projMap.get(cur.projectId)?.name || '',
          baselineProbability: base.probability,
          baselineImpact: base.impact,
          baselineLevel: baseLevel,
          currentProbability: cur.probability,
          currentImpact: cur.impact,
          currentLevel: curLevel,
          escalated: cIdx > bIdx,
          deescalated: cIdx < bIdx,
          isNew: false,
          isRemoved: false,
        });
      } else if (cur && !base) {
        changes.push({
          riskId,
          riskName: cur.name,
          projectId: cur.projectId,
          projectName: projMap.get(cur.projectId)?.name || '',
          baselineProbability: null,
          baselineImpact: null,
          baselineLevel: null,
          currentProbability: cur.probability,
          currentImpact: cur.impact,
          currentLevel: cur.level || riskLevel(cur.probability, cur.impact),
          escalated: false,
          deescalated: false,
          isNew: true,
          isRemoved: false,
        });
      } else if (base && !cur) {
        changes.push({
          riskId,
          riskName: base.name,
          projectId: base.projectId,
          projectName: projMap.get(base.projectId)?.name || '',
          baselineProbability: base.probability,
          baselineImpact: base.impact,
          baselineLevel: base.level || riskLevel(base.probability, base.impact),
          currentProbability: null,
          currentImpact: null,
          currentLevel: null,
          escalated: false,
          deescalated: false,
          isNew: false,
          isRemoved: true,
        });
      }
    }

    return changes;
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  _buildSummary(taskDelays, cpChanges, resChanges, riskChanges) {
    const delayed = taskDelays.filter(d => d.delayDays > 0 && !d.isNew && !d.isRemoved);
    const delayDaysArr = delayed.map(d => d.delayDays);
    const avgDelay = delayDaysArr.length
      ? Math.round(delayDaysArr.reduce((a, b) => a + b, 0) / delayDaysArr.length)
      : 0;

    return {
      totalDelayedTasks: delayed.length,
      avgDelayDays: avgDelay,
      maxDelayDays: delayDaysArr.length ? Math.max(...delayDaysArr) : 0,
      newTasks: taskDelays.filter(d => d.isNew).length,
      removedTasks: taskDelays.filter(d => d.isRemoved).length,
      criticalPathLengthDelta: cpChanges.pathLengthDelta,
      newCriticalTasks: cpChanges.added.length,
      removedCriticalTasks: cpChanges.removed.length,
      newOverloads: resChanges.filter(r => r.currentOverloaded && !r.baselineOverloaded).length,
      resolvedOverloads: resChanges.filter(r => !r.currentOverloaded && r.baselineOverloaded).length,
      escalatedRisks: riskChanges.filter(r => r.escalated).length,
      deescalatedRisks: riskChanges.filter(r => r.deescalated).length,
      newRisks: riskChanges.filter(r => r.isNew).length,
      removedRisks: riskChanges.filter(r => r.isRemoved).length,
    };
  }

  _emptyResult() {
    return {
      taskDelays: [],
      criticalPathChanges: {
        baselineCritical: [], currentCritical: [],
        added: [], removed: [],
        baselinePathLength: 0, currentPathLength: 0, pathLengthDelta: 0,
      },
      resourceOverloadChanges: [],
      riskLevelChanges: [],
      summary: {
        totalDelayedTasks: 0, avgDelayDays: 0, maxDelayDays: 0,
        newTasks: 0, removedTasks: 0,
        criticalPathLengthDelta: 0, newCriticalTasks: 0, removedCriticalTasks: 0,
        newOverloads: 0, resolvedOverloads: 0,
        escalatedRisks: 0, deescalatedRisks: 0, newRisks: 0, removedRisks: 0,
      },
    };
  }
}
