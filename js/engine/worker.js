/**
 * Web Worker for heavy portfolio computations.
 *
 * Runs in a Worker context — receives messages via self.onmessage and
 * posts results back via self.postMessage.  All data is serializable
 * plain objects (no Maps, Sets, or Date instances across the boundary).
 *
 * This file is fully self-contained with no ES module imports.
 */

/* global self */

// ─── Constants ───────────────────────────────────────────────────────
var MS_PER_DAY = 86400000;

// ─── Message router ──────────────────────────────────────────────────
self.onmessage = function (e) {
  var msg = e.data;
  var id = msg.id;
  var type = msg.type;
  var payload = msg.payload || {};

  // Inject the request id into the payload so compute functions can use it
  // for progress reports via reportProgress().
  payload._id = id;

  try {
    var result;
    switch (type) {
      case 'calculate-critical-path':
        result = computeCriticalPath(payload);
        break;
      case 'detect-conflicts':
        result = computeConflicts(payload);
        break;
      case 'propagate-changes':
        result = computePropagation(payload);
        break;
      case 'calculate-risk-matrix':
        result = computeRiskMatrix(payload);
        break;
      case 'calculate-resource-heatmap':
        result = computeResourceHeatmap(payload);
        break;
      case 'parse-csv':
        result = parseCSVInWorker(payload);
        break;
      case 'compute-change-impact':
        result = computeChangeImpact(payload);
        break;
      case 'validate-all':
        result = computeValidation(payload);
        break;
      default:
        throw new Error('Unknown message type: ' + type);
    }
    self.postMessage({ id: id, type: type, result: result, stateVersion: payload._stateVersion || 0 });
  } catch (err) {
    self.postMessage({
      id: id,
      type: type,
      error: err.message || String(err),
      stateVersion: payload._stateVersion || 0,
    });
  }
};

// ─── Progress helper ─────────────────────────────────────────────────
function reportProgress(id, type, pct) {
  self.postMessage({ id: id, type: type, progress: pct });
}

// ═══════════════════════════════════════════════════════════════════════
//  1. CRITICAL PATH  (forward / backward pass)
// ═══════════════════════════════════════════════════════════════════════

function computeCriticalPath(payload) {
  var tasks = payload.tasks; // [{id, name, projectId, dependencies:[], crossProjectDeps:[], plannedStart, plannedEnd, estimatedDays, status, progress}]
  if (!tasks || tasks.length === 0) return { criticalPath: [], tasks: {}, projectDuration: 0 };

  reportProgress(payload._id, 'calculate-critical-path', 10);

  // Build lookup and adjacency
  var taskMap = {};
  var successors = {};
  var predecessors = {};

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    taskMap[t.id] = t;
    successors[t.id] = [];
    predecessors[t.id] = [];
  }

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var deps = (t.dependencies || []).concat(
      (t.crossProjectDeps || []).map(function (d) { return d.taskId; })
    );
    for (var j = 0; j < deps.length; j++) {
      var depId = deps[j];
      if (taskMap[depId]) {
        if (predecessors[t.id].indexOf(depId) === -1) predecessors[t.id].push(depId);
        if (successors[depId].indexOf(t.id) === -1) successors[depId].push(t.id);
      }
    }
  }

  reportProgress(payload._id, 'calculate-critical-path', 25);

  // Compute durations (in working days)
  var durations = {};
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.estimatedDays && t.estimatedDays > 0) {
      durations[t.id] = t.estimatedDays;
    } else if (t.plannedStart && t.plannedEnd) {
      durations[t.id] = workingDaysBetween(t.plannedStart, t.plannedEnd);
    } else {
      durations[t.id] = 1;
    }
  }

  // Find roots (no predecessors)
  var roots = [];
  for (var i = 0; i < tasks.length; i++) {
    if (predecessors[tasks[i].id].length === 0) roots.push(tasks[i].id);
  }

  // Topological sort (Kahn's algorithm)
  var inDegree = {};
  for (var i = 0; i < tasks.length; i++) inDegree[tasks[i].id] = predecessors[tasks[i].id].length;
  var queue = roots.slice();
  var topoOrder = [];
  while (queue.length > 0) {
    var cur = queue.shift();
    topoOrder.push(cur);
    var succs = successors[cur];
    for (var j = 0; j < succs.length; j++) {
      inDegree[succs[j]]--;
      if (inDegree[succs[j]] === 0) queue.push(succs[j]);
    }
  }
  // Handle cycles: add remaining tasks at end
  if (topoOrder.length < tasks.length) {
    for (var i = 0; i < tasks.length; i++) {
      if (topoOrder.indexOf(tasks[i].id) === -1) topoOrder.push(tasks[i].id);
    }
  }

  reportProgress(payload._id, 'calculate-critical-path', 50);

  // Forward pass — Early Start / Early Finish (in working days from project start)
  var ES = {};
  var EF = {};
  for (var i = 0; i < topoOrder.length; i++) {
    var tid = topoOrder[i];
    var maxPredEF = 0;
    var preds = predecessors[tid];
    for (var j = 0; j < preds.length; j++) {
      if ((EF[preds[j]] || 0) > maxPredEF) maxPredEF = EF[preds[j]];
    }
    ES[tid] = maxPredEF;
    EF[tid] = maxPredEF + durations[tid];
  }

  // Project duration
  var projectDuration = 0;
  for (var i = 0; i < tasks.length; i++) {
    if ((EF[tasks[i].id] || 0) > projectDuration) projectDuration = EF[tasks[i].id];
  }

  reportProgress(payload._id, 'calculate-critical-path', 70);

  // Backward pass — Late Start / Late Finish
  var LF = {};
  var LS = {};
  for (var i = topoOrder.length - 1; i >= 0; i--) {
    var tid = topoOrder[i];
    var succs = successors[tid];
    var minSuccLS = projectDuration;
    for (var j = 0; j < succs.length; j++) {
      if ((LS[succs[j]] || projectDuration) < minSuccLS) minSuccLS = LS[succs[j]];
    }
    LF[tid] = minSuccLS;
    LS[tid] = minSuccLS - durations[tid];
  }

  reportProgress(payload._id, 'calculate-critical-path', 85);

  // Float and critical path identification
  var taskResults = {};
  var criticalIds = [];

  for (var i = 0; i < tasks.length; i++) {
    var tid = tasks[i].id;
    var totalFloat = (LS[tid] || 0) - (ES[tid] || 0);
    var freeFloat = 0;
    var succs = successors[tid];
    if (succs.length > 0) {
      var minSuccES = Infinity;
      for (var j = 0; j < succs.length; j++) {
        if ((ES[succs[j]] || 0) < minSuccES) minSuccES = ES[succs[j]];
      }
      freeFloat = minSuccES - (EF[tid] || 0);
    } else {
      freeFloat = projectDuration - (EF[tid] || 0);
    }

    taskResults[tid] = {
      id: tid,
      name: tasks[i].name,
      projectId: tasks[i].projectId,
      duration: durations[tid],
      earlyStart: ES[tid],
      earlyFinish: EF[tid],
      lateStart: LS[tid],
      lateFinish: LF[tid],
      totalFloat: Math.round(totalFloat * 100) / 100,
      freeFloat: Math.round(freeFloat * 100) / 100,
      isCritical: Math.abs(totalFloat) < 0.01,
    };

    if (Math.abs(totalFloat) < 0.01) criticalIds.push(tid);
  }

  // Trace the critical path chain(s) from roots to leaves
  var criticalPath = traceCriticalChains(criticalIds, successors, predecessors, taskResults);

  reportProgress(payload._id, 'calculate-critical-path', 100);

  return {
    criticalPath: criticalPath,
    tasks: taskResults,
    projectDuration: projectDuration,
  };
}

function traceCriticalChains(criticalIds, successors, predecessors, taskResults) {
  var critSet = {};
  for (var i = 0; i < criticalIds.length; i++) critSet[criticalIds[i]] = true;

  // Find starting points: critical tasks with no critical predecessors
  var starts = [];
  for (var i = 0; i < criticalIds.length; i++) {
    var preds = predecessors[criticalIds[i]] || [];
    var hasCritPred = false;
    for (var j = 0; j < preds.length; j++) {
      if (critSet[preds[j]]) { hasCritPred = true; break; }
    }
    if (!hasCritPred) starts.push(criticalIds[i]);
  }

  // Walk forward from each start, following critical successors
  var chain = [];
  var visited = {};
  var queue = starts.slice();
  while (queue.length > 0) {
    var cur = queue.shift();
    if (visited[cur]) continue;
    visited[cur] = true;
    chain.push(cur);
    var succs = successors[cur] || [];
    for (var j = 0; j < succs.length; j++) {
      if (critSet[succs[j]] && !visited[succs[j]]) queue.push(succs[j]);
    }
  }

  return chain;
}

// ═══════════════════════════════════════════════════════════════════════
//  2. RESOURCE CONFLICT DETECTION
// ═══════════════════════════════════════════════════════════════════════

function computeConflicts(payload) {
  var resources = payload.resources; // [{id, name, department, tasks:[{taskId, projectId, allocation}], maxCapacity}]
  var tasks = payload.tasks;         // [{id, name, projectId, plannedStart, plannedEnd}]

  var taskMap = {};
  for (var i = 0; i < tasks.length; i++) taskMap[tasks[i].id] = tasks[i];

  var projectMap = {};
  if (payload.projects) {
    for (var i = 0; i < payload.projects.length; i++) projectMap[payload.projects[i].id] = payload.projects[i];
  }

  var conflicts = [];
  var total = resources.length;

  for (var ri = 0; ri < resources.length; ri++) {
    if (ri % 5 === 0) reportProgress(payload._id, 'detect-conflicts', Math.round((ri / total) * 80) + 10);

    var resource = resources[ri];
    if (!resource.tasks || resource.tasks.length === 0) continue;

    // Build event map for this resource
    var eventsMap = {};
    for (var ti = 0; ti < resource.tasks.length; ti++) {
      var rt = resource.tasks[ti];
      var task = taskMap[rt.taskId];
      if (!task || !task.plannedStart || !task.plannedEnd) continue;

      var startKey = toDateStr(task.plannedStart);
      var endPlusOne = addDaysStr(task.plannedEnd, 1);

      if (!eventsMap[startKey]) eventsMap[startKey] = { adds: [], removes: [] };
      eventsMap[startKey].adds.push({ taskId: rt.taskId, projectId: rt.projectId || task.projectId, allocation: rt.allocation });

      if (!eventsMap[endPlusOne]) eventsMap[endPlusOne] = { adds: [], removes: [] };
      eventsMap[endPlusOne].removes.push(rt.taskId);
    }

    var sortedDates = Object.keys(eventsMap).sort();
    var active = {};
    var maxDateStr = null;

    // Determine the max end date across all tasks
    for (var ti = 0; ti < resource.tasks.length; ti++) {
      var task = taskMap[resource.tasks[ti].taskId];
      if (task && task.plannedEnd) {
        var ds = toDateStr(task.plannedEnd);
        if (!maxDateStr || ds > maxDateStr) maxDateStr = ds;
      }
    }

    for (var di = 0; di < sortedDates.length; di++) {
      var dateStr = sortedDates[di];
      var ev = eventsMap[dateStr];

      for (var k = 0; k < ev.removes.length; k++) delete active[ev.removes[k]];
      for (var k = 0; k < ev.adds.length; k++) active[ev.adds[k].taskId] = ev.adds[k];

      if (!isWorkingDayStr(dateStr)) continue;
      if (maxDateStr && dateStr > maxDateStr) continue;

      var totalAlloc = 0;
      var taskEntries = [];
      var ids = Object.keys(active);
      for (var k = 0; k < ids.length; k++) {
        var entry = active[ids[k]];
        totalAlloc += entry.allocation;
        var task = taskMap[entry.taskId];
        var project = projectMap[entry.projectId];
        taskEntries.push({
          taskId: entry.taskId,
          projectId: entry.projectId,
          taskName: task ? task.name : '',
          projectName: project ? project.name : '',
          allocation: entry.allocation,
        });
      }

      if (totalAlloc > resource.maxCapacity) {
        conflicts.push({
          resourceId: resource.id,
          resourceName: resource.name,
          department: resource.department,
          date: dateStr,
          totalAllocation: totalAlloc,
          maxCapacity: resource.maxCapacity,
          tasks: taskEntries,
        });
      }
    }
  }

  reportProgress(payload._id, 'detect-conflicts', 100);
  return conflicts;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. CHANGE PROPAGATION  (BFS through dependency graph)
// ═══════════════════════════════════════════════════════════════════════

function computePropagation(payload) {
  var tasks = payload.tasks;       // [{id, plannedStart, plannedEnd, dependencies:[], crossProjectDeps:[{projectId, taskId}]}]
  var changedTaskId = payload.changedTaskId;
  var newStart = payload.newStart; // ISO date string
  var newEnd = payload.newEnd;     // ISO date string

  if (!tasks || tasks.length === 0) return { changes: [], warnings: [] };

  var taskMap = {};
  var successors = {};
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    taskMap[t.id] = t;
    successors[t.id] = [];
  }

  // Build successor adjacency
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var deps = (t.dependencies || []).concat(
      (t.crossProjectDeps || []).map(function (d) { return d.taskId; })
    );
    for (var j = 0; j < deps.length; j++) {
      if (taskMap[deps[j]] && successors[deps[j]].indexOf(t.id) === -1) {
        successors[deps[j]].push(t.id);
      }
    }
  }

  var changes = [];
  var warnings = [];
  var visited = {};

  // Compute the shift in working days
  var changedTask = taskMap[changedTaskId];
  if (!changedTask) return { changes: changes, warnings: ['Changed task not found: ' + changedTaskId] };

  var origEnd = changedTask.plannedEnd;
  var deltaDays = workingDaysBetween(origEnd, newEnd);

  // BFS from the changed task's successors
  var queue = successors[changedTaskId].slice();
  visited[changedTaskId] = true;

  // Track updated end dates for cascade correctness
  var updatedEnds = {};
  updatedEnds[changedTaskId] = newEnd;

  var iterations = 0;
  var maxIterations = tasks.length * 2; // safety limit for cycles

  while (queue.length > 0 && iterations < maxIterations) {
    iterations++;
    var curId = queue.shift();
    if (visited[curId]) continue;
    visited[curId] = true;

    var cur = taskMap[curId];
    if (!cur) continue;

    // Find the latest end date among all predecessors (including updated ones)
    var allDeps = (cur.dependencies || []).concat(
      (cur.crossProjectDeps || []).map(function (d) { return d.taskId; })
    );

    var latestPredEnd = null;
    for (var j = 0; j < allDeps.length; j++) {
      var predEnd = updatedEnds[allDeps[j]] || (taskMap[allDeps[j]] ? taskMap[allDeps[j]].plannedEnd : null);
      if (predEnd && (!latestPredEnd || predEnd > latestPredEnd)) latestPredEnd = predEnd;
    }

    if (!latestPredEnd) continue;

    // The task must start the working day after its latest predecessor ends
    var proposedStart = nextWorkingDayStr(latestPredEnd);
    var curDuration = workingDaysBetween(cur.plannedStart, cur.plannedEnd);
    if (curDuration < 1) curDuration = 1;
    var proposedEnd = addWorkingDaysStr(proposedStart, curDuration - 1);

    // Record the change if dates actually shifted
    if (proposedStart !== cur.plannedStart || proposedEnd !== cur.plannedEnd) {
      updatedEnds[curId] = proposedEnd;
      changes.push({
        taskId: curId,
        taskName: cur.name || '',
        projectId: cur.projectId,
        oldStart: cur.plannedStart,
        oldEnd: cur.plannedEnd,
        newStart: proposedStart,
        newEnd: proposedEnd,
        shiftDays: deltaDays,
      });

      // Enqueue successors
      var succs = successors[curId];
      for (var k = 0; k < succs.length; k++) {
        if (!visited[succs[k]]) queue.push(succs[k]);
      }
    }

    if (iterations % 50 === 0) {
      reportProgress(payload._id, 'propagate-changes', Math.min(90, 20 + Math.round((iterations / maxIterations) * 70)));
    }
  }

  if (iterations >= maxIterations) {
    warnings.push('Propagation stopped: possible circular dependency detected.');
  }

  reportProgress(payload._id, 'propagate-changes', 100);
  return { changes: changes, warnings: warnings };
}

// ═══════════════════════════════════════════════════════════════════════
//  4. RISK MATRIX
// ═══════════════════════════════════════════════════════════════════════

function computeRiskMatrix(payload) {
  var risks = payload.risks; // [{id, name, projectId, probability, impact, status, category}]
  if (!risks) risks = [];

  var matrix = [];
  var summary = { low: 0, medium: 0, high: 0, critical: 0, total: 0 };

  for (var p = 5; p >= 1; p--) {
    var row = [];
    for (var imp = 1; imp <= 5; imp++) {
      var score = p * imp;
      var level = riskScoreToLevel(score);
      var cellRisks = [];
      for (var k = 0; k < risks.length; k++) {
        if (risks[k].probability === p && risks[k].impact === imp) {
          cellRisks.push(risks[k]);
        }
      }
      row.push({
        probability: p,
        impact: imp,
        risks: cellRisks,
        count: cellRisks.length,
        level: level,
      });
      summary[level] += cellRisks.length;
      summary.total += cellRisks.length;
    }
    matrix.push(row);
  }

  return { matrix: matrix, summary: summary };
}

// ═══════════════════════════════════════════════════════════════════════
//  5. RESOURCE HEATMAP
// ═══════════════════════════════════════════════════════════════════════

function computeResourceHeatmap(payload) {
  var resources = payload.resources; // [{id, name, tasks:[{taskId, projectId, allocation}]}]
  var tasks = payload.tasks;         // [{id, plannedStart, plannedEnd}]
  var startDate = payload.startDate; // ISO date string
  var endDate = payload.endDate;     // ISO date string

  var taskMap = {};
  for (var i = 0; i < tasks.length; i++) taskMap[tasks[i].id] = tasks[i];

  // Build date array (working days only)
  var dates = [];
  var cur = new Date(startDate + 'T00:00:00');
  var end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    var dow = cur.getDay();
    if (dow !== 0 && dow !== 6) dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }

  var dateIdx = {};
  for (var i = 0; i < dates.length; i++) dateIdx[dates[i]] = i;

  var resourceInfos = [];
  var data = [];

  for (var ri = 0; ri < resources.length; ri++) {
    var resource = resources[ri];
    resourceInfos.push({ id: resource.id, name: resource.name });

    var row = [];
    for (var di = 0; di < dates.length; di++) row.push({ allocation: 0, taskCount: 0 });

    if (resource.tasks) {
      for (var ti = 0; ti < resource.tasks.length; ti++) {
        var rt = resource.tasks[ti];
        var task = taskMap[rt.taskId];
        if (!task || !task.plannedStart || !task.plannedEnd) continue;

        var rStart = task.plannedStart > startDate ? task.plannedStart : startDate;
        var rEnd = task.plannedEnd < endDate ? task.plannedEnd : endDate;

        for (var di = 0; di < dates.length; di++) {
          if (dates[di] >= rStart && dates[di] <= rEnd) {
            row[di].allocation += rt.allocation;
            row[di].taskCount += 1;
          }
        }
      }
    }

    data.push(row);

    if (ri % 5 === 0) {
      reportProgress(payload._id, 'calculate-resource-heatmap', Math.round((ri / resources.length) * 90) + 5);
    }
  }

  reportProgress(payload._id, 'calculate-resource-heatmap', 100);
  return { resources: resourceInfos, dates: dates, data: data };
}

// ═══════════════════════════════════════════════════════════════════════
//  6. CSV PARSER
// ═══════════════════════════════════════════════════════════════════════

function parseCSVInWorker(payload) {
  var text = payload.text;
  var delimiter = payload.delimiter || ',';
  var hasHeader = payload.hasHeader !== false;

  if (!text || text.length === 0) return { headers: [], rows: [], errors: [] };

  reportProgress(payload._id, 'parse-csv', 10);

  var rows = [];
  var errors = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var lineNum = 1;
  var len = text.length;

  for (var i = 0; i < len; i++) {
    var ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r') {
        // skip carriage return
      } else if (ch === '\n') {
        row.push(field.trim());
        field = '';
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
          rows.push(row);
        }
        row = [];
        lineNum++;
      } else {
        field += ch;
      }
    }

    // Progress for large files
    if (i % 100000 === 0 && i > 0) {
      reportProgress(payload._id, 'parse-csv', 10 + Math.round((i / len) * 80));
    }
  }

  // Flush last field/row
  row.push(field.trim());
  if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
    rows.push(row);
  }

  reportProgress(payload._id, 'parse-csv', 95);

  var headers = [];
  var dataRows = rows;

  if (hasHeader && rows.length > 0) {
    headers = rows[0];
    dataRows = rows.slice(1);
  }

  // Validate: check for inconsistent column counts
  var expectedCols = headers.length > 0 ? headers.length : (dataRows.length > 0 ? dataRows[0].length : 0);
  for (var r = 0; r < dataRows.length; r++) {
    if (dataRows[r].length !== expectedCols) {
      errors.push({
        row: r + (hasHeader ? 2 : 1),
        message: 'Expected ' + expectedCols + ' columns, got ' + dataRows[r].length,
      });
    }
  }

  // Build objects if headers exist
  var result = [];
  if (headers.length > 0) {
    for (var r = 0; r < dataRows.length; r++) {
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = dataRows[r][c] !== undefined ? dataRows[r][c] : '';
      }
      result.push(obj);
    }
  }

  reportProgress(payload._id, 'parse-csv', 100);

  return {
    headers: headers,
    rows: result.length > 0 ? result : dataRows,
    errors: errors,
    totalRows: dataRows.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  DATE UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function toDateStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.length > 10 ? val.slice(0, 10) : val;
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = ('0' + (val.getMonth() + 1)).slice(-2);
    var d = ('0' + val.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  return String(val);
}

function isWorkingDayStr(dateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  var dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

function addDaysStr(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function nextWorkingDayStr(dateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

function addWorkingDaysStr(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00');
  var remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) remaining--;
  }
  return toDateStr(d);
}

function workingDaysBetween(startStr, endStr) {
  if (!startStr || !endStr) return 1;
  var start = new Date(startStr + 'T00:00:00');
  var end = new Date(endStr + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 1;

  var count = 0;
  var d = new Date(start);
  while (d <= end) {
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(count, 1);
}

function riskScoreToLevel(score) {
  if (score >= 20) return 'critical';
  if (score >= 12) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

// ═══════════════════════════════════════════════════════════════════════
//  7. CHANGE IMPACT — diff between baseline and current snapshots
// ═══════════════════════════════════════════════════════════════════════

function computeChangeImpact(payload) {
  var baselineSnapshot = payload.baselineSnapshot;
  var currentSnapshot = payload.currentSnapshot;
  var baselineCritIds = payload.baselineCriticalPath || [];
  var currentCritIds = payload.currentCriticalPath || [];

  reportProgress(payload._id, 'compute-change-impact', 10);

  // Build task maps
  var blTaskMap = {};
  var i;
  for (i = 0; i < (baselineSnapshot.tasks || []).length; i++) {
    blTaskMap[baselineSnapshot.tasks[i].id] = baselineSnapshot.tasks[i];
  }
  var curTaskMap = {};
  for (i = 0; i < (currentSnapshot.tasks || []).length; i++) {
    curTaskMap[currentSnapshot.tasks[i].id] = currentSnapshot.tasks[i];
  }

  // Build critical path sets
  var blCritSet = {};
  for (i = 0; i < baselineCritIds.length; i++) blCritSet[baselineCritIds[i]] = true;
  var curCritSet = {};
  for (i = 0; i < currentCritIds.length; i++) curCritSet[currentCritIds[i]] = true;

  reportProgress(payload._id, 'compute-change-impact', 25);

  // Diff tasks
  var taskChanges = [];
  var curIds = Object.keys(curTaskMap);
  for (i = 0; i < curIds.length; i++) {
    var id = curIds[i];
    var cur = curTaskMap[id];
    var bl = blTaskMap[id];
    var isNew = !bl;

    var delayDays = 0;
    if (!isNew && bl.plannedEnd && cur.plannedEnd) {
      if (bl.plannedEnd === cur.plannedEnd) {
        delayDays = 0;
      } else {
        var blEnd = new Date(bl.plannedEnd + 'T00:00:00');
        var curEnd = new Date(cur.plannedEnd + 'T00:00:00');
        if (!isNaN(blEnd.getTime()) && !isNaN(curEnd.getTime())) {
          var sign = curEnd >= blEnd ? 1 : -1;
          var from = sign === 1 ? blEnd : curEnd;
          var to = sign === 1 ? curEnd : blEnd;
          var cnt = 0;
          var d = new Date(from);
          while (d <= to) {
            var dow = d.getDay();
            if (dow !== 0 && dow !== 6) cnt++;
            d.setDate(d.getDate() + 1);
          }
          delayDays = sign * cnt;
        }
      }
    }

    var wasCritical = !!blCritSet[id];
    var isCritical = !!curCritSet[id];

    taskChanges.push({
      taskId: id,
      taskName: cur.name || '',
      projectId: cur.projectId || '',
      delayDays: delayDays,
      baselineStart: bl ? (bl.plannedStart || '') : '',
      baselineEnd: bl ? (bl.plannedEnd || '') : '',
      currentStart: cur.plannedStart || '',
      currentEnd: cur.plannedEnd || '',
      addedToCriticalPath: !wasCritical && isCritical,
      removedFromCriticalPath: wasCritical && !isCritical,
      wasCritical: wasCritical,
      isCritical: isCritical,
      baselineStatus: bl ? (bl.status || '') : '',
      currentStatus: cur.status || '',
      baselineProgress: bl ? (bl.progress || 0) : 0,
      currentProgress: cur.progress || 0,
      baselineAssignee: bl ? (bl.assignee || '') : '',
      currentAssignee: cur.assignee || '',
      baselineDeps: bl ? (bl.dependencies || []).slice() : [],
      currentDeps: (cur.dependencies || []).slice(),
      isNew: isNew,
      isDeleted: false,
    });
  }

  // Deleted tasks (in baseline but not current)
  var blIds = Object.keys(blTaskMap);
  for (i = 0; i < blIds.length; i++) {
    var bid = blIds[i];
    if (!curTaskMap[bid]) {
      var blt = blTaskMap[bid];
      taskChanges.push({
        taskId: bid, taskName: blt.name || '', projectId: blt.projectId || '',
        delayDays: 0,
        baselineStart: blt.plannedStart || '', baselineEnd: blt.plannedEnd || '',
        currentStart: '', currentEnd: '',
        addedToCriticalPath: false, removedFromCriticalPath: !!blCritSet[bid],
        wasCritical: !!blCritSet[bid], isCritical: false,
        baselineStatus: blt.status || '', currentStatus: '',
        baselineProgress: blt.progress || 0, currentProgress: 0,
        baselineAssignee: blt.assignee || '', currentAssignee: '',
        baselineDeps: (blt.dependencies || []).slice(), currentDeps: [],
        isNew: false, isDeleted: true,
      });
    }
  }

  reportProgress(payload._id, 'compute-change-impact', 50);

  // Critical path diff
  var cpAdded = [];
  var cpRemoved = [];
  for (i = 0; i < currentCritIds.length; i++) {
    if (!blCritSet[currentCritIds[i]]) cpAdded.push(currentCritIds[i]);
  }
  for (i = 0; i < baselineCritIds.length; i++) {
    if (!curCritSet[baselineCritIds[i]]) cpRemoved.push(baselineCritIds[i]);
  }

  reportProgress(payload._id, 'compute-change-impact', 65);

  // Resource overload diff
  var blResMap = {};
  for (i = 0; i < (baselineSnapshot.resources || []).length; i++) {
    blResMap[baselineSnapshot.resources[i].id] = baselineSnapshot.resources[i];
  }
  var curResMap = {};
  for (i = 0; i < (currentSnapshot.resources || []).length; i++) {
    curResMap[currentSnapshot.resources[i].id] = currentSnapshot.resources[i];
  }

  var resourceOverloadDiff = [];
  var resIds = Object.keys(curResMap);
  for (i = 0; i < resIds.length; i++) {
    var resId = resIds[i];
    var curRes = curResMap[resId];
    if (!curRes.tasks || curRes.tasks.length === 0) continue;

    var curOverloads = findOverloadDatesInWorker(curRes, curTaskMap);
    var blRes = blResMap[resId];
    var blOverloads = blRes ? findOverloadDatesInWorker(blRes, blTaskMap) : {};

    var newOverloads = [];
    var resolvedOverloads = [];
    var date;
    for (date in curOverloads) {
      if (!blOverloads[date]) {
        newOverloads.push({ date: date, totalAllocation: curOverloads[date].total, causativeTasks: [] });
      }
    }
    for (date in blOverloads) {
      if (!curOverloads[date]) {
        resolvedOverloads.push({ date: date, totalAllocation: blOverloads[date].total });
      }
    }

    if (newOverloads.length > 0 || resolvedOverloads.length > 0) {
      resourceOverloadDiff.push({
        resourceId: resId, resourceName: curRes.name || '',
        newOverloads: newOverloads, resolvedOverloads: resolvedOverloads,
      });
    }
  }

  reportProgress(payload._id, 'compute-change-impact', 80);

  // Risk diff
  var blRiskMap = {};
  for (i = 0; i < (baselineSnapshot.risks || []).length; i++) {
    blRiskMap[baselineSnapshot.risks[i].id] = baselineSnapshot.risks[i];
  }
  var curRiskMap = {};
  for (i = 0; i < (currentSnapshot.risks || []).length; i++) {
    curRiskMap[currentSnapshot.risks[i].id] = currentSnapshot.risks[i];
  }

  var riskChanges = [];
  var riskIds = Object.keys(curRiskMap);
  for (i = 0; i < riskIds.length; i++) {
    var rid = riskIds[i];
    var curR = curRiskMap[rid];
    var blR = blRiskMap[rid];
    if (!blR) {
      riskChanges.push({
        riskId: rid, name: curR.name || '', oldLevel: '', newLevel: curR.level || 'low',
        oldScore: 0, newScore: (curR.probability || 1) * (curR.impact || 1), direction: 'new',
      });
      continue;
    }
    var oldScore = (blR.probability || 1) * (blR.impact || 1);
    var newScore = (curR.probability || 1) * (curR.impact || 1);
    var direction = newScore > oldScore ? 'upgraded' : newScore < oldScore ? 'downgraded' : 'unchanged';
    if (direction !== 'unchanged') {
      riskChanges.push({
        riskId: rid, name: curR.name || '',
        oldLevel: blR.level || riskScoreToLevel(oldScore),
        newLevel: curR.level || riskScoreToLevel(newScore),
        oldScore: oldScore, newScore: newScore, direction: direction,
      });
    }
  }

  reportProgress(payload._id, 'compute-change-impact', 95);

  // Build summary
  var totalTasksChanged = 0;
  var totalDelayDays = 0;
  for (i = 0; i < taskChanges.length; i++) {
    var tc = taskChanges[i];
    if (tc.delayDays !== 0 || tc.isNew || tc.isDeleted || tc.addedToCriticalPath || tc.removedFromCriticalPath) {
      totalTasksChanged++;
    }
    if (tc.delayDays > 0) totalDelayDays += tc.delayDays;
  }

  var newOvlCount = 0;
  var resolvedOvlCount = 0;
  for (i = 0; i < resourceOverloadDiff.length; i++) {
    newOvlCount += resourceOverloadDiff[i].newOverloads.length;
    resolvedOvlCount += resourceOverloadDiff[i].resolvedOverloads.length;
  }

  var risksUpgraded = 0;
  var risksDowngraded = 0;
  for (i = 0; i < riskChanges.length; i++) {
    if (riskChanges[i].direction === 'upgraded') risksUpgraded++;
    if (riskChanges[i].direction === 'downgraded') risksDowngraded++;
  }

  return {
    taskChanges: taskChanges,
    criticalPathDiff: { added: cpAdded, removed: cpRemoved },
    resourceOverloadDiff: resourceOverloadDiff,
    riskChanges: riskChanges,
    summary: {
      totalTasksChanged: totalTasksChanged,
      totalDelayDays: totalDelayDays,
      criticalPathAdded: cpAdded.length,
      criticalPathRemoved: cpRemoved.length,
      newOverloads: newOvlCount,
      resolvedOverloads: resolvedOvlCount,
      risksUpgraded: risksUpgraded,
      risksDowngraded: risksDowngraded,
    },
  };
}

/** Helper: find overload dates for a resource given a task map */
function findOverloadDatesInWorker(resource, taskMap) {
  var overloads = {};
  var maxCap = resource.maxCapacity || 100;
  if (!resource.tasks) return overloads;

  var dayMap = {};
  for (var i = 0; i < resource.tasks.length; i++) {
    var assignment = resource.tasks[i];
    var task = taskMap[assignment.taskId];
    if (!task || !task.plannedStart || !task.plannedEnd) continue;

    var start = new Date(task.plannedStart + 'T00:00:00');
    var end = new Date(task.plannedEnd + 'T00:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

    var alloc = assignment.allocation || 0;
    var d = new Date(start);
    while (d <= end) {
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        var dateStr = toDateStr(d);
        if (!dayMap[dateStr]) dayMap[dateStr] = { total: 0, tasks: [] };
        dayMap[dateStr].total += alloc;
        dayMap[dateStr].tasks.push(assignment.taskId);
      }
      d.setDate(d.getDate() + 1);
    }
  }

  for (var dt in dayMap) {
    if (dayMap[dt].total > maxCap) {
      overloads[dt] = dayMap[dt];
    }
  }

  return overloads;
}

// ═══════════════════════════════════════════════════════════════════════
//  8. VALIDATION — circular deps, dangling refs, duplicate allocations
// ═══════════════════════════════════════════════════════════════════════

function computeValidation(payload) {
  var tasks = payload.tasks || [];
  var resources = payload.resources || [];
  var issues = [];

  reportProgress(payload._id, 'validate-all', 10);

  // Build task lookup
  var taskMap = {};
  for (var i = 0; i < tasks.length; i++) {
    taskMap[tasks[i].id] = tasks[i];
  }

  // 1. Circular dependency detection (tri-colour DFS)
  var adj = {};
  for (i = 0; i < tasks.length; i++) {
    var waitsFor = [];
    var deps = tasks[i].dependencies || [];
    for (var j = 0; j < deps.length; j++) {
      if (taskMap[deps[j]]) waitsFor.push(deps[j]);
    }
    var cpDeps = tasks[i].crossProjectDeps || [];
    for (j = 0; j < cpDeps.length; j++) {
      if (taskMap[cpDeps[j].taskId]) waitsFor.push(cpDeps[j].taskId);
    }
    adj[tasks[i].id] = waitsFor;
  }

  var color = {};
  for (i = 0; i < tasks.length; i++) color[tasks[i].id] = 0;
  var cycles = [];

  function dfsCycle(nodeId, path) {
    color[nodeId] = 1;
    path.push(nodeId);
    var neighbors = adj[nodeId] || [];
    for (var k = 0; k < neighbors.length; k++) {
      var next = neighbors[k];
      if (color[next] === 1) {
        var idx = path.indexOf(next);
        cycles.push(path.slice(idx));
      } else if (color[next] === 0) {
        dfsCycle(next, path);
      }
    }
    path.pop();
    color[nodeId] = 2;
  }

  for (i = 0; i < tasks.length; i++) {
    if (color[tasks[i].id] === 0) dfsCycle(tasks[i].id, []);
  }

  for (i = 0; i < cycles.length; i++) {
    issues.push({
      severity: 'error',
      type: 'circular-dep',
      message: 'Circular dependency involving ' + cycles[i].length + ' tasks',
      affectedIds: cycles[i],
    });
  }

  reportProgress(payload._id, 'validate-all', 50);

  // 2. Dangling cross-project refs
  for (i = 0; i < tasks.length; i++) {
    var cpdList = tasks[i].crossProjectDeps || [];
    for (j = 0; j < cpdList.length; j++) {
      if (!taskMap[cpdList[j].taskId]) {
        issues.push({
          severity: 'warning',
          type: 'dangling-cross-ref',
          message: 'Task "' + (tasks[i].name || tasks[i].id) + '" references non-existent task "' + cpdList[j].taskId + '"',
          affectedIds: [tasks[i].id],
        });
      }
    }
  }

  reportProgress(payload._id, 'validate-all', 75);

  // 3. Duplicate resource allocations
  for (i = 0; i < resources.length; i++) {
    var res = resources[i];
    if (!res.tasks) continue;
    var seen = {};
    for (j = 0; j < res.tasks.length; j++) {
      var tid = res.tasks[j].taskId;
      seen[tid] = (seen[tid] || 0) + 1;
    }
    for (var tId in seen) {
      if (seen[tId] > 1) {
        issues.push({
          severity: 'warning',
          type: 'duplicate-allocation',
          message: 'Resource "' + (res.name || res.id) + '" assigned to task "' + tId + '" ' + seen[tId] + ' times',
          affectedIds: [res.id, tId],
        });
      }
    }
  }

  reportProgress(payload._id, 'validate-all', 100);

  return issues;
}
