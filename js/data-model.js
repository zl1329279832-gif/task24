/* ============================================================
   data-model.js  –  Central data store
   ============================================================ */
const DataModel = (() => {
    let _projects = {};   // projectId -> { id, name, pm, department }
    let _tasks = {};      // taskId -> task object
    let _risks = [];      // risk objects
    let _resources = [];  // resource allocation objects
    let _listeners = [];

    function on(fn) { _listeners.push(fn); }
    function _notify(type) { _listeners.forEach(fn => fn(type)); }

    function clear() {
        _projects = {}; _tasks = {}; _risks = []; _resources = [];
        _notify('clear');
    }

    function importTasks(taskList, merge = true) {
        if (!merge) { _projects = {}; _tasks = {}; }
        taskList.forEach(t => {
            if (!_projects[t.projectId]) {
                _projects[t.projectId] = { id: t.projectId, name: t.projectName, pm: t.assignee, department: t.department };
            }
            _tasks[t.taskId] = {
                ...t,
                delayDays: 0,
                isCritical: false,
                earlyStart: null, earlyFinish: null,
                lateStart: null, lateFinish: null,
                totalFloat: 0
            };
        });
        _notify('tasks');
    }

    function importRisks(riskList, merge = true) {
        if (!merge) _risks = [];
        _risks = _risks.concat(riskList);
        _notify('risks');
    }

    function importResources(resList, merge = true) {
        if (!merge) _resources = [];
        _resources = _resources.concat(resList);
        _notify('resources');
    }

    function getProjects() { return _projects; }
    function getProjectList() { return Object.values(_projects); }
    function getTasks() { return _tasks; }
    function getTaskList() { return Object.values(_tasks); }
    function getTask(id) { return _tasks[id]; }
    function getRisks() { return _risks; }
    function getResources() { return _resources; }

    function updateTask(taskId, changes) {
        if (!_tasks[taskId]) return;
        Object.assign(_tasks[taskId], changes);
        _notify('task-update');
    }

    function getProjectTasks(projectId) {
        return Object.values(_tasks).filter(t => t.projectId === projectId);
    }

    function getFilteredTasks(filters) {
        return Object.values(_tasks).filter(t => {
            if (filters.department && t.department !== filters.department) return false;
            if (filters.pm && t.assignee !== filters.pm) return false;
            if (filters.status && t.status !== filters.status) return false;
            if (filters.project && t.projectId !== filters.project) return false;
            if (filters.riskLevel) {
                const riskLevel = _getTaskRiskLevel(t.taskId);
                if (riskLevel !== filters.riskLevel) return false;
            }
            return true;
        });
    }

    function _getTaskRiskLevel(taskId) {
        const task = _tasks[taskId];
        if (!task) return 'low';
        if (task.delayDays > 10 || task.status === 'delayed') return 'high';
        if (task.delayDays > 3) return 'medium';
        return 'low';
    }

    function getDepartments() {
        const set = new Set();
        Object.values(_tasks).forEach(t => { if (t.department) set.add(t.department); });
        return [...set].sort();
    }

    function getAssignees() {
        const set = new Set();
        Object.values(_tasks).forEach(t => { if (t.assignee) set.add(t.assignee); });
        return [...set].sort();
    }

    function getDateRange() {
        let min = null, max = null;
        Object.values(_tasks).forEach(t => {
            const dates = [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd].filter(Boolean);
            dates.forEach(d => {
                if (!min || d < min) min = d;
                if (!max || d > max) max = d;
            });
        });
        if (!min) min = Utils.today();
        if (!max) max = Utils.addDays(min, 90);
        // Pad
        min = Utils.addDays(min, -7);
        max = Utils.addDays(max, 14);
        return { min, max };
    }

    function getSnapshot() {
        return Utils.serializeDates({ projects: _projects, tasks: _tasks, risks: _risks, resources: _resources });
    }

    function restoreSnapshot(snap) {
        const d = Utils.deserializeDates(snap);
        _projects = d.projects || {};
        _tasks = d.tasks || {};
        _risks = d.risks || [];
        _resources = d.resources || [];
        // Restore Date objects in tasks
        Object.values(_tasks).forEach(t => {
            ['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd', 'earlyStart', 'earlyFinish', 'lateStart', 'lateFinish'].forEach(k => {
                if (t[k] && typeof t[k] === 'string') t[k] = new Date(t[k]);
            });
        });
        _notify('restore');
    }

    function getMilestones() {
        return Object.values(_tasks).filter(t => t.isMilestone);
    }

    function getResourceConflicts() {
        // Group allocations by person and check for overlapping periods > 100%
        const byPerson = {};
        // From task data
        Object.values(_tasks).forEach(t => {
            if (!t.assignee || !t.plannedStart || !t.plannedEnd) return;
            if (!byPerson[t.assignee]) byPerson[t.assignee] = [];
            byPerson[t.assignee].push({
                person: t.assignee,
                department: t.department,
                projectId: t.projectId,
                projectName: t.projectName || _projects[t.projectId]?.name || t.projectId,
                taskId: t.taskId,
                taskName: t.taskName,
                allocation: t.effort || 100,
                start: t.actualStart || t.plannedStart,
                end: t.actualEnd || t.plannedEnd
            });
        });
        // From explicit resources
        _resources.forEach(r => {
            if (!r.person || !r.startDate || !r.endDate) return;
            if (!byPerson[r.person]) byPerson[r.person] = [];
            byPerson[r.person].push({
                ...r,
                start: r.startDate,
                end: r.endDate,
                taskName: r.taskId,
                projectName: _projects[r.projectId]?.name || r.projectId
            });
        });

        const conflicts = [];
        Object.entries(byPerson).forEach(([person, allocs]) => {
            if (allocs.length < 2) return;
            // Check every day in range for overload
            let earliest = null, latest = null;
            allocs.forEach(a => {
                if (!earliest || a.start < earliest) earliest = a.start;
                if (!latest || a.end > latest) latest = a.end;
            });
            const totalDays = Utils.daysBetween(earliest, latest);
            const overloadPeriods = [];
            let inOverload = false;
            let overloadStart = null;

            for (let d = 0; d <= totalDays; d++) {
                const day = Utils.addDays(earliest, d);
                let totalAlloc = 0;
                const activeTasks = [];
                allocs.forEach(a => {
                    if (day >= a.start && day <= a.end) {
                        totalAlloc += a.allocation;
                        activeTasks.push(a);
                    }
                });
                if (totalAlloc > 100) {
                    if (!inOverload) { inOverload = true; overloadStart = day; }
                } else if (inOverload) {
                    inOverload = false;
                    overloadPeriods.push({ start: overloadStart, end: Utils.addDays(day, -1) });
                }
            }
            if (inOverload) overloadPeriods.push({ start: overloadStart, end: latest });

            if (overloadPeriods.length > 0) {
                conflicts.push({
                    person,
                    department: allocs[0].department,
                    allocations: allocs,
                    overloadPeriods,
                    maxAllocation: _calcMaxAlloc(allocs, earliest, latest)
                });
            }
        });
        return conflicts;
    }

    function _calcMaxAlloc(allocs, earliest, latest) {
        let max = 0;
        const totalDays = Utils.daysBetween(earliest, latest);
        for (let d = 0; d <= totalDays; d++) {
            const day = Utils.addDays(earliest, d);
            let total = 0;
            allocs.forEach(a => { if (day >= a.start && day <= a.end) total += a.allocation; });
            if (total > max) max = total;
        }
        return max;
    }

    return {
        on, clear, importTasks, importRisks, importResources,
        getProjects, getProjectList, getTasks, getTaskList, getTask,
        getRisks, getResources, updateTask, getProjectTasks,
        getFilteredTasks, getDepartments, getAssignees, getDateRange,
        getSnapshot, restoreSnapshot, getMilestones, getResourceConflicts
    };
})();
