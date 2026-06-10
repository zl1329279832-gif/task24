/* ============================================================
   scheduler-worker.js  –  Web Worker for heavy computation
   Offloads CPM calculation and resource conflict detection
   to avoid blocking the main thread with large datasets.
   ============================================================ */

self.onmessage = function(e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'calculateCPM':
            self.postMessage({ type: 'cpmResult', payload: calculateCPM(payload.tasks) });
            break;
        case 'detectConflicts':
            self.postMessage({ type: 'conflictResult', payload: detectResourceConflicts(payload.tasks, payload.resources) });
            break;
    }
};

function calculateCPM(tasks) {
    const taskMap = {};
    Object.values(tasks).forEach(t => { taskMap[t.taskId] = { ...t }; });

    // Restore date objects
    Object.values(taskMap).forEach(t => {
        ['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd'].forEach(k => {
            if (t[k] && typeof t[k] === 'string') t[k] = new Date(t[k]);
            if (t[k] && t[k].__date__) t[k] = new Date(t[k].__date__);
        });
    });

    // Detect and break cycles
    const brokenEdges = breakCycles(taskMap);

    // Topological sort
    const sorted = topoSort(taskMap);

    // Forward pass
    sorted.forEach(id => {
        const t = taskMap[id];
        if (!t || !t.plannedStart || !t.plannedEnd) return;
        const duration = daysBetween(t.plannedStart, t.plannedEnd);

        let es = t.plannedStart;
        if (t.dependencies && t.dependencies.length > 0) {
            t.dependencies.forEach(depId => {
                const dep = taskMap[depId];
                if (dep && dep.earlyFinish && dep.earlyFinish > es) es = dep.earlyFinish;
            });
        }
        t.earlyStart = es;
        t.earlyFinish = addDays(es, duration);
    });

    // Find max finish
    const maxFinish = sorted.reduce((max, id) => {
        const t = taskMap[id];
        return (t && t.earlyFinish && t.earlyFinish > max) ? t.earlyFinish : max;
    }, new Date(0));

    // Successor map
    const successors = {};
    Object.keys(taskMap).forEach(id => { successors[id] = []; });
    Object.values(taskMap).forEach(t => {
        if (t.dependencies) {
            t.dependencies.forEach(depId => {
                if (successors[depId]) successors[depId].push(t.taskId);
            });
        }
    });

    // Backward pass
    for (let i = sorted.length - 1; i >= 0; i--) {
        const id = sorted[i];
        const t = taskMap[id];
        if (!t || !t.plannedStart || !t.plannedEnd) continue;
        const duration = daysBetween(t.plannedStart, t.plannedEnd);

        if (successors[id].length === 0) {
            t.lateFinish = maxFinish;
        } else {
            let lf = maxFinish;
            successors[id].forEach(succId => {
                const s = taskMap[succId];
                if (s && s.lateStart && s.lateStart < lf) lf = s.lateStart;
            });
            t.lateFinish = lf;
        }
        t.lateStart = addDays(t.lateFinish, -duration);
        t.totalFloat = daysBetween(t.earlyStart, t.lateStart);
        t.isCritical = t.totalFloat <= 0;
    }

    return { taskMap, brokenEdges, criticalPath: sorted.filter(id => taskMap[id]?.isCritical) };
}

function detectResourceConflicts(tasks, resources) {
    const byPerson = {};
    Object.values(tasks).forEach(t => {
        if (!t.assignee || !t.plannedStart || !t.plannedEnd) return;
        if (!byPerson[t.assignee]) byPerson[t.assignee] = [];
        byPerson[t.assignee].push({
            allocation: t.effort || 100,
            start: new Date(t.plannedStart),
            end: new Date(t.plannedEnd)
        });
    });

    const conflicts = [];
    Object.entries(byPerson).forEach(([person, allocs]) => {
        if (allocs.length < 2) return;
        let hasConflict = false;
        // Sample check (every 3 days for performance)
        let earliest = allocs.reduce((m, a) => (!m || a.start < m) ? a.start : m, null);
        let latest = allocs.reduce((m, a) => (!m || a.end > m) ? a.end : m, null);
        const totalDays = daysBetween(earliest, latest);

        for (let d = 0; d <= totalDays; d += 3) {
            const day = addDays(earliest, d);
            let total = 0;
            allocs.forEach(a => { if (day >= a.start && day <= a.end) total += a.allocation; });
            if (total > 100) { hasConflict = true; break; }
        }
        if (hasConflict) conflicts.push(person);
    });

    return conflicts;
}

function breakCycles(taskMap) {
    const visited = new Set();
    const recStack = new Set();
    const broken = [];

    function dfs(id, path) {
        visited.add(id);
        recStack.add(id);
        path.push(id);
        const t = taskMap[id];
        if (t && t.dependencies) {
            for (let i = t.dependencies.length - 1; i >= 0; i--) {
                const depId = t.dependencies[i];
                if (!visited.has(depId)) {
                    dfs(depId, [...path]);
                } else if (recStack.has(depId)) {
                    t.dependencies.splice(i, 1);
                    broken.push({ from: id, to: depId });
                }
            }
        }
        recStack.delete(id);
    }

    Object.keys(taskMap).forEach(id => { if (!visited.has(id)) dfs(id, []); });
    return broken;
}

function topoSort(taskMap) {
    const inDegree = {};
    const adj = {};
    Object.values(taskMap).forEach(t => { inDegree[t.taskId] = 0; adj[t.taskId] = []; });
    Object.values(taskMap).forEach(t => {
        if (t.dependencies) {
            t.dependencies.forEach(depId => {
                if (adj[depId]) { adj[depId].push(t.taskId); inDegree[t.taskId]++; }
            });
        }
    });
    const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
    const sorted = [];
    while (queue.length) {
        const id = queue.shift();
        sorted.push(id);
        (adj[id] || []).forEach(next => { inDegree[next]--; if (inDegree[next] === 0) queue.push(next); });
    }
    return sorted;
}

function daysBetween(a, b) {
    if (!a || !b) return 0;
    return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}
