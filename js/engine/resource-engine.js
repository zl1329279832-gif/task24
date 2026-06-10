/**
 * ResourceEngine — resource conflict detection, workload analysis,
 * overload detection, leveling suggestions, and utilization metrics.
 *
 * All heavy date iteration uses an event-based sweep algorithm so that
 * large portfolios with wide date ranges stay performant.
 */

// ─── Constants ───────────────────────────────────────────────────────
const MS_PER_DAY = 86400000;
const DEFAULT_OVERLOAD_THRESHOLD = 1.0;
const DEFAULT_LOOKAHEAD_DAYS = 30;

// ─── Utility helpers ─────────────────────────────────────────────────
function isWorkingDay(date) {
  const d = date.getDay();
  return d !== 0 && d !== 6;
}

function addDays(date, days) {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function toISODate(date) {
  return date.toISOString().split('T')[0];
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function countWorkingDays(start, end) {
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    if (isWorkingDay(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * Build a chronologically sorted list of unique working-day strings
 * that fall within [minDate, maxDate] and appear as keys in eventsMap.
 */
function workingDaysFromEvents(eventsMap, minDate, maxDate) {
  const days = [];
  const cursor = new Date(minDate);
  while (cursor <= maxDate) {
    if (isWorkingDay(cursor)) {
      const key = toISODate(cursor);
      if (eventsMap.has(key)) days.push(key);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * Sweep-line expansion: given an array of
 * {taskId, projectId, allocation, start, end} ranges, return an ordered
 * array of {date, tasks} snapshots for every working day covered.
 *
 * Uses start/end+1 events so we never iterate empty days.
 */
function expandRangesToDailySnapshots(ranges) {
  if (ranges.length === 0) return [];

  const eventsMap = new Map();
  let minDate = null;
  let maxDate = null;

  for (const range of ranges) {
    const { start, end } = range;
    if (!start || !end || end < start) continue;

    if (!minDate || start < minDate) minDate = new Date(start);
    if (!maxDate || end > maxDate) maxDate = new Date(end);

    const startKey = toISODate(start);
    if (!eventsMap.has(startKey)) eventsMap.set(startKey, { adds: [], removes: [] });
    eventsMap.get(startKey).adds.push(range);

    const removeKey = toISODate(addDays(end, 1));
    if (!eventsMap.has(removeKey)) eventsMap.set(removeKey, { adds: [], removes: [] });
    eventsMap.get(removeKey).removes.push(range);
  }

  if (!minDate || !maxDate) return [];

  const sortedDates = [...eventsMap.keys()].sort();
  const active = new Map();
  const snapshots = [];

  for (const dateStr of sortedDates) {
    const { adds, removes } = eventsMap.get(dateStr);

    // Removals from previous range that ends here
    for (const r of removes) active.delete(r.taskId);

    // New tasks starting on this date
    for (const r of adds) active.set(r.taskId, r);

    if (active.size === 0) continue;

    const dateObj = new Date(dateStr + 'T00:00:00');
    if (dateObj > maxDate || !isWorkingDay(dateObj)) continue;

    snapshots.push({
      date: dateStr,
      tasks: [...active.values()],
    });
  }

  return snapshots;
}

// ─── Engine ──────────────────────────────────────────────────────────
export class ResourceEngine {
  constructor(store) {
    this._store = store;
    this._cache = new Map();
    this._cacheVersion = 0;
  }

  // ── Conflict detection ───────────────────────────────────────────
  detectConflicts() {
    this._invalidateIfStale();
    const cached = this._cache.get('conflicts');
    if (cached) return cached;

    const resources = [...this._store.state.resources.values()];
    const taskMap = this._store.state.tasks;
    const projectMap = this._store.state.projects;
    const conflicts = [];

    for (const resource of resources) {
      if (!resource.tasks || resource.tasks.length === 0) continue;

      const ranges = this._buildRanges(resource, taskMap);
      const snapshots = expandRangesToDailySnapshots(ranges);

      for (const snap of snapshots) {
        let total = 0;
        const taskDetails = [];

        for (const r of snap.tasks) {
          total += r.allocation;
          const task = taskMap.get(r.taskId);
          const project = projectMap.get(r.projectId);
          taskDetails.push({
            taskId: r.taskId,
            projectId: r.projectId,
            taskName: task?.name ?? '',
            projectName: project?.name ?? '',
            allocation: r.allocation,
          });
        }

        if (total > resource.maxCapacity) {
          conflicts.push({
            resourceId: resource.id,
            resourceName: resource.name,
            department: resource.department,
            date: snap.date,
            totalAllocation: total,
            maxCapacity: resource.maxCapacity,
            tasks: taskDetails,
          });
        }
      }
    }

    this._cache.set('conflicts', conflicts);
    return conflicts;
  }

  // ── Workload calculation ─────────────────────────────────────────
  calculateWorkload(resourceId, startDate, endDate) {
    this._invalidateIfStale();

    const resource = this._store.state.resources.get(resourceId);
    if (!resource) return null;

    const taskMap = this._store.state.tasks;
    const ranges = this._buildRanges(resource, taskMap);

    const filtered = ranges.filter((r) => {
      if (!r.start || !r.end) return false;
      if (startDate && r.end < startDate) return false;
      if (endDate && r.start > endDate) return false;
      return true;
    });

    const snapshots = expandRangesToDailySnapshots(filtered);

    const effectiveStart = startDate
      ? toISODate(startDate)
      : (snapshots[0]?.date ?? toISODate(new Date()));
    const effectiveEnd = endDate
      ? toISODate(endDate)
      : (snapshots.length > 0 ? snapshots[snapshots.length - 1].date : effectiveStart);

    // Fill gaps so every working day in the window appears
    const snapMap = new Map(snapshots.map((s) => [s.date, s]));
    const dailyLoad = [];
    const cursor = new Date(effectiveStart + 'T00:00:00');
    const limit = new Date(effectiveEnd + 'T00:00:00');

    while (cursor <= limit) {
      if (isWorkingDay(cursor)) {
        const key = toISODate(cursor);
        const snap = snapMap.get(key);
        if (snap) {
          let alloc = 0;
          const tasks = [];
          for (const r of snap.tasks) {
            alloc += r.allocation;
            const task = taskMap.get(r.taskId);
            tasks.push({ taskId: r.taskId, taskName: task?.name ?? '', projectId: r.projectId });
          }
          dailyLoad.push({ date: key, allocation: alloc, tasks });
        } else {
          dailyLoad.push({ date: key, allocation: 0, tasks: [] });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    const totalLoad = dailyLoad.reduce((s, d) => s + d.allocation, 0);
    const averageLoad = dailyLoad.length > 0 ? totalLoad / dailyLoad.length : 0;
    const peakLoad = dailyLoad.reduce((m, d) => Math.max(m, d.allocation), 0);
    const overloadedDays = dailyLoad.filter((d) => d.allocation > resource.maxCapacity).length;

    return {
      resourceId: resource.id,
      resourceName: resource.name,
      dailyLoad,
      averageLoad: Math.round(averageLoad * 100) / 100,
      peakLoad,
      overloadedDays,
    };
  }

  // ── Overload detection ───────────────────────────────────────────
  findOverloadedResources(threshold = DEFAULT_OVERLOAD_THRESHOLD) {
    this._invalidateIfStale();

    const resources = [...this._store.state.resources.values()];
    const taskMap = this._store.state.tasks;
    const overloaded = [];

    for (const resource of resources) {
      if (!resource.tasks || resource.tasks.length === 0) continue;

      const ranges = this._buildRanges(resource, taskMap);
      const snapshots = expandRangesToDailySnapshots(ranges);

      let peakDaily = 0;
      let peakTasks = [];

      for (const snap of snapshots) {
        let dayTotal = 0;
        for (const r of snap.tasks) dayTotal += r.allocation;
        if (dayTotal > peakDaily) {
          peakDaily = dayTotal;
          peakTasks = snap.tasks;
        }
      }

      if (resource.maxCapacity <= 0) continue;

      const ratio = peakDaily / resource.maxCapacity;
      if (ratio > threshold) {
        const affectedTasks = peakTasks
          .map((r) => taskMap.get(r.taskId))
          .filter(Boolean);

        overloaded.push({
          resourceId: resource.id,
          resourceName: resource.name,
          totalAllocation: peakDaily,
          maxCapacity: resource.maxCapacity,
          overloadPercentage: Math.round((ratio - 1) * 10000) / 100,
          affectedTasks,
        });
      }
    }

    return overloaded.sort((a, b) => b.overloadPercentage - a.overloadPercentage);
  }

  // ── Leveling suggestions ──────────────────────────────────────────
  suggestLeveling() {
    this._invalidateIfStale();

    const overloaded = this.findOverloadedResources();
    if (overloaded.length === 0) return [];

    const resources = [...this._store.state.resources.values()];
    const taskMap = this._store.state.tasks;
    const suggestions = [];

    for (const entry of overloaded) {
      const resource = this._store.state.resources.get(entry.resourceId);
      if (!resource) continue;

      // Identify under-loaded peers in the same department
      const departmentPeers = resources.filter(
        (r) =>
          r.id !== resource.id &&
          r.department === resource.department &&
          (!r.tasks || r.tasks.length === 0 || this._isUnderloaded(r, taskMap)),
      );

      // Gather task info and sort by priority ascending (lowest first)
      const taskInfos = (resource.tasks || [])
        .map((rt) => {
          const task = taskMap.get(rt.taskId);
          return task ? { rt, task } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.task.priority ?? 3) - (b.task.priority ?? 3));

      // 1) Delay low-priority tasks
      const lowPriority = taskInfos.filter((t) => (t.task.priority ?? 3) >= 3);
      for (const { rt, task } of lowPriority.slice(0, 2)) {
        const delayDays = Math.ceil(entry.overloadPercentage / 20) * 5;
        suggestions.push({
          type: 'delay',
          resourceId: resource.id,
          taskId: rt.taskId,
          suggestion: `Delay "${task.name}" by ${delayDays} working days to reduce peak load`,
          impact: `Shifts task end from ${task.plannedEnd ?? 'TBD'} to approximately ${this._addWorkingDays(task.plannedEnd, delayDays)}`,
        });
      }

      // 2) Reassign to department peers
      if (departmentPeers.length > 0) {
        const reassignable = taskInfos.filter((t) => (t.task.priority ?? 3) <= 3);
        for (const { rt, task } of reassignable.slice(0, 2)) {
          const target = departmentPeers[0];
          suggestions.push({
            type: 'reassign',
            resourceId: resource.id,
            taskId: rt.taskId,
            suggestion: `Reassign "${task.name}" to ${target.name} (${target.department})`,
            impact: `Frees ${rt.allocation} units from ${resource.name}; ${target.name} has available capacity`,
          });
        }
      }

      // 3) Split the largest allocation task
      if (taskInfos.length > 1) {
        const biggest = taskInfos.reduce((a, b) => (a.rt.allocation > b.rt.allocation ? a : b));
        const splitCount = Math.min(3, departmentPeers.length + 1);
        if (splitCount > 1) {
          suggestions.push({
            type: 'split',
            resourceId: resource.id,
            taskId: biggest.rt.taskId,
            suggestion: `Split "${biggest.task.name}" across ${splitCount} resources`,
            impact: `Reduces per-resource allocation from ${biggest.rt.allocation} to ~${Math.ceil(biggest.rt.allocation / splitCount)}`,
          });
        }
      }
    }

    return suggestions;
  }

  // ── Utilization stats ────────────────────────────────────────────
  getResourceUtilization(startDate, endDate) {
    this._invalidateIfStale();

    const start = startDate ?? this._defaultStart();
    const end = endDate ?? addDays(start, DEFAULT_LOOKAHEAD_DAYS);
    const totalWorkingDays = countWorkingDays(start, end);

    const resources = [...this._store.state.resources.values()];
    const taskMap = this._store.state.tasks;
    const utilization = new Map();

    for (const resource of resources) {
      if (totalWorkingDays === 0 || resource.maxCapacity <= 0) {
        utilization.set(resource.id, {
          utilization: 0,
          allocated: 0,
          available: resource.maxCapacity || 0,
          tasks: 0,
        });
        continue;
      }

      const ranges = this._buildRanges(resource, taskMap).filter((r) => {
        if (!r.start || !r.end) return false;
        const rStart = r.start > start ? r.start : start;
        const rEnd = r.end < end ? r.end : end;
        return rStart <= rEnd;
      });

      let totalAllocated = 0;
      const taskIds = new Set();

      for (const range of ranges) {
        const rStart = range.start > start ? range.start : start;
        const rEnd = range.end < end ? range.end : end;
        const days = countWorkingDays(rStart, rEnd);
        totalAllocated += range.allocation * days;
        taskIds.add(range.taskId);
      }

      const totalAvailable = resource.maxCapacity * totalWorkingDays;
      const pct = totalAvailable > 0 ? (totalAllocated / totalAvailable) * 100 : 0;

      utilization.set(resource.id, {
        utilization: Math.round(pct * 100) / 100,
        allocated: totalAllocated,
        available: totalAvailable,
        tasks: taskIds.size,
      });
    }

    return utilization;
  }

  // ── Heatmap ──────────────────────────────────────────────────────
  getResourceHeatmap(startDate, endDate) {
    this._invalidateIfStale();

    const taskMap = this._store.state.tasks;
    const start = startDate ?? this._defaultStart();
    const end = endDate ?? addDays(start, DEFAULT_LOOKAHEAD_DAYS);

    // Collect all working-day dates in range
    const dates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      if (isWorkingDay(cursor)) dates.push(toISODate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    const dateIndex = new Map(dates.map((d, i) => [d, i]));
    const resources = [...this._store.state.resources.values()];

    const resourceInfos = [];
    const data = [];

    for (const resource of resources) {
      resourceInfos.push({ id: resource.id, name: resource.name });

      const row = dates.map(() => ({ allocation: 0, taskCount: 0 }));

      if (resource.tasks && resource.tasks.length > 0) {
        for (const rt of resource.tasks) {
          const task = taskMap.get(rt.taskId);
          if (!task) continue;

          const pStart = parseDate(task.plannedStart);
          const pEnd = parseDate(task.plannedEnd);
          if (!pStart || !pEnd) continue;

          const rangeStart = toISODate(pStart > start ? pStart : start);
          const rangeEnd = toISODate(pEnd < end ? pEnd : end);

          for (let i = 0; i < dates.length; i++) {
            if (dates[i] >= rangeStart && dates[i] <= rangeEnd) {
              row[i].allocation += rt.allocation;
              row[i].taskCount += 1;
            }
          }
        }
      }

      data.push(row);
    }

    return { resources: resourceInfos, dates, data };
  }

  // ── Cache management ─────────────────────────────────────────────
  clearCache() {
    this._cache.clear();
    this._cacheVersion = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Rebuild ranges for a single resource from its task assignments. */
  _buildRanges(resource, taskMap) {
    const ranges = [];
    if (!resource.tasks) return ranges;

    for (const rt of resource.tasks) {
      const task = taskMap.get(rt.taskId);
      if (!task) continue;

      const start = parseDate(task.plannedStart);
      const end = parseDate(task.plannedEnd);
      if (!start || !end || end < start) continue;

      ranges.push({
        taskId: rt.taskId,
        projectId: rt.projectId ?? task.projectId,
        allocation: rt.allocation,
        start,
        end,
      });
    }

    return ranges;
  }

  /** Quick check whether a resource's peak daily load is below capacity. */
  _isUnderloaded(resource, taskMap) {
    const ranges = this._buildRanges(resource, taskMap);
    if (ranges.length === 0) return true;

    const snapshots = expandRangesToDailySnapshots(ranges);
    for (const snap of snapshots) {
      let total = 0;
      for (const r of snap.tasks) total += r.allocation;
      if (total >= resource.maxCapacity) return false;
    }
    return true;
  }

  /** Add N working days to a date string; returns ISO date string. */
  _addWorkingDays(dateStr, days) {
    const d = parseDate(dateStr);
    if (!d) return 'TBD';
    let remaining = days;
    while (remaining > 0) {
      d.setDate(d.getDate() + 1);
      if (isWorkingDay(d)) remaining--;
    }
    return toISODate(d);
  }

  /** Fallback start date: earliest task plannedStart or today. */
  _defaultStart() {
    let earliest = new Date();
    for (const task of this._store.state.tasks.values()) {
      const d = parseDate(task.plannedStart);
      if (d && d < earliest) earliest = d;
    }
    return earliest;
  }

  /** Invalidate all cached results when the underlying store has changed. */
  _invalidateIfStale() {
    const s = this._store.state;
    const version = `${s.tasks.size}:${s.resources.size}`;
    if (this._cacheVersion !== version) {
      this._cache.clear();
      this._cacheVersion = version;
    }
  }
}
