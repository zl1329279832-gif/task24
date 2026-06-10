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
      default:
        throw new Error('Unknown message type: ' + type);
    }
    self.postMessage({ id: id, type: type, result: result });
  } catch (err) {
    self.postMessage({
      id: id,
      type: type,
      error: err.message || String(err),
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
