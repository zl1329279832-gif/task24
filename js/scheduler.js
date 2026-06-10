/* ============================================================
   scheduler.js  –  Dependency resolution, CPM, cycle detection
   ============================================================ */
const Scheduler = (() => {

    // Detect circular dependencies using DFS
    function detectCycles(tasks) {
        const taskMap = {};
        Object.values(tasks).forEach(t => { taskMap[t.taskId] = t; });

        const visited = new Set();
        const recStack = new Set();
        const cycles = [];

        function dfs(id, path) {
            visited.add(id);
            recStack.add(id);
            path.push(id);

            const task = taskMap[id];
            if (task && task.dependencies) {
                for (const depId of task.dependencies) {
                    if (!visited.has(depId)) {
                        dfs(depId, [...path]);
                    } else if (recStack.has(depId)) {
                        const cycleStart = path.indexOf(depId);
                        cycles.push(path.slice(cycleStart).concat(depId));
                    }
                }
            }
            recStack.delete(id);
        }

        Object.keys(taskMap).forEach(id => {
            if (!visited.has(id)) dfs(id, []);
        });

        return cycles;
    }

    // Break cycles by removing last edge in each cycle
    function breakCycles(tasks) {
        const cycles = detectCycles(tasks);
        const brokenEdges = [];
        cycles.forEach(cycle => {
            if (cycle.length < 2) return;
            const lastTask = cycle[cycle.length - 2];
            const firstTask = cycle[cycle.length - 1];
            const task = tasks[lastTask];
            if (task) {
                const idx = task.dependencies.indexOf(firstTask);
                if (idx >= 0) {
                    task.dependencies.splice(idx, 1);
                    brokenEdges.push({ from: lastTask, to: firstTask });
                }
            }
        });
        return brokenEdges;
    }

    // Topological sort (Kahn's algorithm)
    function topoSort(tasks) {
        const taskMap = {};
        const inDegree = {};
        const adj = {};

        Object.values(tasks).forEach(t => {
            taskMap[t.taskId] = t;
            inDegree[t.taskId] = 0;
            adj[t.taskId] = [];
        });

        Object.values(tasks).forEach(t => {
            if (t.dependencies) {
                t.dependencies.forEach(depId => {
                    if (taskMap[depId]) {
                        adj[depId] = adj[depId] || [];
                        adj[depId].push(t.taskId);
                        inDegree[t.taskId] = (inDegree[t.taskId] || 0) + 1;
                    }
                });
            }
        });

        const queue = [];
        Object.keys(inDegree).forEach(id => {
            if (inDegree[id] === 0) queue.push(id);
        });

        const sorted = [];
        while (queue.length > 0) {
            const id = queue.shift();
            sorted.push(id);
            (adj[id] || []).forEach(next => {
                inDegree[next]--;
                if (inDegree[next] === 0) queue.push(next);
            });
        }
        return sorted;
    }

    // Critical Path Method (CPM)
    function calculateCPM(tasks) {
        const taskMap = {};
        Object.values(tasks).forEach(t => { taskMap[t.taskId] = t; });

        // Break any cycles first
        const brokenEdges = breakCycles(taskMap);

        const sorted = topoSort(taskMap);

        // Forward pass – Early Start / Early Finish
        sorted.forEach(id => {
            const t = taskMap[id];
            if (!t || !t.plannedStart || !t.plannedEnd) return;
            const duration = Utils.daysBetween(t.plannedStart, t.plannedEnd);

            let es = t.plannedStart;
            if (t.dependencies && t.dependencies.length > 0) {
                t.dependencies.forEach(depId => {
                    const dep = taskMap[depId];
                    if (dep && dep.earlyFinish && dep.earlyFinish > es) {
                        es = dep.earlyFinish;
                    }
                });
            }
            t.earlyStart = es;
            t.earlyFinish = Utils.addDays(es, duration);
        });

        // Backward pass – Late Start / Late Finish
        const maxFinish = sorted.reduce((max, id) => {
            const t = taskMap[id];
            return (t && t.earlyFinish && t.earlyFinish > max) ? t.earlyFinish : max;
        }, new Date(0));

        // Build reverse adjacency
        const revAdj = {};
        Object.values(taskMap).forEach(t => {
            revAdj[t.taskId] = [];
        });
        Object.values(taskMap).forEach(t => {
            if (t.dependencies) {
                t.dependencies.forEach(depId => {
                    if (revAdj[depId] !== undefined) {
                        // depId's successor includes t
                    }
                    if (revAdj[t.taskId] !== undefined) {
                        // No need, we build successor list below
                    }
                });
            }
        });

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
            const duration = Utils.daysBetween(t.plannedStart, t.plannedEnd);

            if (successors[id].length === 0) {
                t.lateFinish = maxFinish;
            } else {
                let lf = maxFinish;
                successors[id].forEach(succId => {
                    const s = taskMap[succId];
                    if (s && s.lateStart && s.lateStart < lf) {
                        lf = s.lateStart;
                    }
                });
                t.lateFinish = lf;
            }
            t.lateStart = Utils.addDays(t.lateFinish, -duration);
            t.totalFloat = Utils.daysBetween(t.earlyStart, t.lateStart);
            t.isCritical = t.totalFloat <= 0;
        }

        // Calculate delay days
        const today = Utils.today();
        Object.values(taskMap).forEach(t => {
            if (!t.plannedEnd) { t.delayDays = 0; return; }
            if (t.actualEnd) {
                t.delayDays = Math.max(0, Utils.daysBetween(t.plannedEnd, t.actualEnd));
            } else if (t.status !== 'completed') {
                if (today > t.plannedEnd) {
                    t.delayDays = Utils.daysBetween(t.plannedEnd, today);
                } else {
                    t.delayDays = 0;
                }
            } else {
                t.delayDays = 0;
            }
            // Update status if delayed
            if (t.delayDays > 0 && t.status !== 'completed') {
                t.status = 'delayed';
            }
        });

        return { brokenEdges, criticalPath: sorted.filter(id => taskMap[id]?.isCritical) };
    }

    // Reschedule downstream tasks after a task is moved
    function rescheduleDownstream(taskId, tasks) {
        const taskMap = {};
        Object.values(tasks).forEach(t => { taskMap[t.taskId] = t; });

        // Build successor map
        const successors = {};
        Object.keys(taskMap).forEach(id => { successors[id] = []; });
        Object.values(taskMap).forEach(t => {
            if (t.dependencies) {
                t.dependencies.forEach(depId => {
                    if (successors[depId]) successors[depId].push(t.taskId);
                });
            }
        });

        // BFS from taskId
        const queue = [...(successors[taskId] || [])];
        const visited = new Set();
        const changes = [];

        while (queue.length > 0) {
            const id = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);

            const t = taskMap[id];
            if (!t || !t.plannedStart || !t.plannedEnd) continue;

            // Find latest dependency end
            let latestDepEnd = null;
            (t.dependencies || []).forEach(depId => {
                const dep = taskMap[depId];
                if (dep && dep.plannedEnd) {
                    if (!latestDepEnd || dep.plannedEnd > latestDepEnd) {
                        latestDepEnd = dep.plannedEnd;
                    }
                }
            });

            if (latestDepEnd && latestDepEnd > t.plannedStart) {
                const duration = Utils.daysBetween(t.plannedStart, t.plannedEnd);
                const oldStart = t.plannedStart;
                t.plannedStart = latestDepEnd;
                t.plannedEnd = Utils.addDays(latestDepEnd, duration);
                changes.push({ taskId: id, oldStart, newStart: t.plannedStart, newEnd: t.plannedEnd });
            }

            (successors[id] || []).forEach(s => {
                if (!visited.has(s)) queue.push(s);
            });
        }

        return changes;
    }

    return { detectCycles, breakCycles, topoSort, calculateCPM, rescheduleDownstream };
})();
