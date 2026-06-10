/* ============================================================
   resource.js  –  Resource conflict detection & display
   ============================================================ */
const ResourceView = (() => {
    let _container;

    function init() {
        _container = document.getElementById('resource-container');
    }

    function render(filters) {
        const conflicts = DataModel.getResourceConflicts();
        const tasks = filters ? DataModel.getFilteredTasks(filters) : DataModel.getTaskList();

        // Build person allocation summary
        const personSummary = _buildPersonSummary(tasks);

        let html = '';

        // Conflict summary
        if (conflicts.length > 0) {
            html += `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:20px">
                <h3 style="color:#dc2626;margin-bottom:8px;font-size:14px">⚠ 发现 ${conflicts.length} 个资源冲突</h3>
                <div style="display:flex;flex-wrap:wrap;gap:12px">`;

            conflicts.forEach(c => {
                html += `<div style="background:#fff;border-radius:6px;padding:10px 14px;border:1px solid #fecaca;min-width:200px">
                    <div style="font-weight:600">${_esc(c.person)}</div>
                    <div style="font-size:11px;color:#64748b">${_esc(c.department || '')}</div>
                    <div style="color:#dc2626;font-size:12px;margin-top:4px">最高负荷: ${c.maxAllocation}%</div>
                    <div style="font-size:11px;color:#64748b;margin-top:2px">冲突时段: ${c.overloadPeriods.length}个</div>
                </div>`;
            });

            html += '</div></div>';
        } else {
            html += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px">
                <h3 style="color:#16a34a;font-size:14px">✓ 无资源冲突</h3>
            </div>`;
        }

        // Resource allocation table
        html += '<h3 style="margin-bottom:12px;font-size:14px">人员资源投入概览</h3>';
        html += `<table class="resource-table">
            <thead><tr>
                <th>人员</th><th>部门</th><th>参与任务数</th><th>当前负荷</th><th>负荷分布</th><th>时间范围</th><th>状态</th>
            </tr></thead><tbody>`;

        personSummary.sort((a, b) => b.currentLoad - a.currentLoad);

        personSummary.forEach(p => {
            const isOverload = p.currentLoad > 100;
            const barClass = p.currentLoad > 100 ? 'resource-bar-danger' : p.currentLoad > 80 ? 'resource-bar-warn' : 'resource-bar-ok';
            const barWidth = Math.min(p.currentLoad, 200);

            html += `<tr class="${isOverload ? 'resource-overload' : ''}">
                <td style="font-weight:500">${_esc(p.person)}</td>
                <td>${_esc(p.department)}</td>
                <td>${p.taskCount}</td>
                <td>
                    <span style="font-weight:600;color:${isOverload ? '#dc2626' : p.currentLoad > 80 ? '#b45309' : '#1e293b'}">${p.currentLoad}%</span>
                    ${isOverload ? '<span class="conflict-badge">超负荷</span>' : ''}
                </td>
                <td>
                    <div style="width:200px;height:16px;background:#f1f5f9;border-radius:3px;overflow:hidden">
                        <div class="resource-bar ${barClass}" style="width:${barWidth}px"></div>
                    </div>
                </td>
                <td style="font-size:11px">${p.dateRange}</td>
                <td>${_statusBadge(p.currentLoad)}</td>
            </tr>`;
        });

        html += '</tbody></table>';

        // Detailed conflict info
        if (conflicts.length > 0) {
            html += '<h3 style="margin:24px 0 12px;font-size:14px">冲突详情</h3>';
            conflicts.forEach(c => {
                html += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px">
                    <h4 style="font-size:13px;margin-bottom:8px">${_esc(c.person)} <span style="color:#64748b;font-weight:normal">${_esc(c.department || '')}</span></h4>`;

                html += '<div style="font-size:12px;margin-bottom:8px;color:#dc2626">冲突时段:</div>';
                c.overloadPeriods.forEach(op => {
                    html += `<div style="font-size:11px;color:#64748b;margin-left:12px">
                        ${Utils.formatDate(op.start)} ~ ${Utils.formatDate(op.end)} (${Utils.daysBetween(op.start, op.end)}天)
                    </div>`;
                });

                html += '<div style="font-size:12px;margin:8px 0 4px">分配的任务:</div>';
                html += '<table style="width:100%;font-size:11px;border-collapse:collapse">';
                c.allocations.forEach(a => {
                    html += `<tr style="border-bottom:1px solid #f1f5f9">
                        <td style="padding:4px 8px">${_esc(a.projectName)}</td>
                        <td style="padding:4px 8px">${_esc(a.taskName)}</td>
                        <td style="padding:4px 8px">${a.allocation}%</td>
                        <td style="padding:4px 8px">${Utils.formatDate(a.start)} ~ ${Utils.formatDate(a.end)}</td>
                    </tr>`;
                });
                html += '</table></div>';
            });
        }

        _container.innerHTML = html;
    }

    function _buildPersonSummary(tasks) {
        const byPerson = {};
        const today = Utils.today();

        tasks.forEach(t => {
            if (!t.assignee) return;
            if (!byPerson[t.assignee]) {
                byPerson[t.assignee] = {
                    person: t.assignee,
                    department: t.department || '',
                    taskCount: 0,
                    currentLoad: 0,
                    tasks: [],
                    minDate: null,
                    maxDate: null
                };
            }
            const p = byPerson[t.assignee];
            p.taskCount++;
            p.tasks.push(t);

            const start = t.actualStart || t.plannedStart;
            const end = t.actualEnd || t.plannedEnd;
            if (start && (!p.minDate || start < p.minDate)) p.minDate = start;
            if (end && (!p.maxDate || end > p.maxDate)) p.maxDate = end;

            // Current load: sum of effort for tasks active today
            if (start && end && today >= start && today <= end && t.status !== 'completed') {
                p.currentLoad += t.effort || 100;
            }
        });

        return Object.values(byPerson).map(p => ({
            ...p,
            dateRange: p.minDate && p.maxDate ? `${Utils.formatDate(p.minDate)} ~ ${Utils.formatDate(p.maxDate)}` : '-'
        }));
    }

    function _statusBadge(load) {
        if (load > 100) return '<span class="risk-badge risk-high">超负荷</span>';
        if (load > 80) return '<span class="risk-badge risk-medium">高负荷</span>';
        if (load > 0) return '<span class="risk-badge risk-low">正常</span>';
        return '<span style="color:#94a3b8;font-size:11px">空闲</span>';
    }

    function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    return { init, render };
})();
