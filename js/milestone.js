/* ============================================================
   milestone.js  –  Milestone timeline view
   ============================================================ */
const MilestoneView = (() => {
    let _container;

    function init() {
        _container = document.getElementById('milestone-container');
    }

    function render(filters) {
        const tasks = filters ? DataModel.getFilteredTasks(filters) : DataModel.getTaskList();
        const milestones = tasks.filter(t => t.isMilestone);

        if (milestones.length === 0) {
            _container.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">暂无里程碑数据</div>';
            return;
        }

        // Group by project
        const byProject = {};
        milestones.forEach(m => {
            if (!byProject[m.projectId]) byProject[m.projectId] = [];
            byProject[m.projectId].push(m);
        });

        // Find date range for positioning
        let minDate = null, maxDate = null;
        milestones.forEach(m => {
            const d = m.actualEnd || m.plannedEnd || m.plannedStart;
            if (!d) return;
            if (!minDate || d < minDate) minDate = d;
            if (!maxDate || d > maxDate) maxDate = d;
        });
        if (!minDate) minDate = Utils.today();
        if (!maxDate) maxDate = Utils.addDays(minDate, 90);
        minDate = Utils.addDays(minDate, -14);
        maxDate = Utils.addDays(maxDate, 14);
        const totalDays = Utils.daysBetween(minDate, maxDate);

        let html = '<div class="milestone-timeline">';

        // Today marker info
        const todayPct = (Utils.daysBetween(minDate, Utils.today()) / totalDays * 100);

        // Date axis
        html += '<div style="display:flex;margin-left:180px;margin-bottom:12px;position:relative;height:24px">';
        const months = _getMonthMarkers(minDate, maxDate, totalDays);
        months.forEach(m => {
            html += `<span style="position:absolute;left:${m.pct}%;font-size:11px;color:#64748b;font-weight:600">${m.label}</span>`;
        });
        // Today marker on axis
        html += `<span style="position:absolute;left:${todayPct}%;color:#ef4444;font-size:10px;font-weight:bold;transform:translateX(-50%)">▼今天</span>`;
        html += '</div>';

        Object.entries(byProject).forEach(([pid, ms]) => {
            const proj = DataModel.getProjects()[pid];
            ms.sort((a, b) => (a.plannedStart || 0) - (b.plannedStart || 0));

            html += '<div class="milestone-track">';
            html += `<div class="milestone-project-label">${_esc(proj?.name || pid)}</div>`;
            html += '<div class="milestone-items">';
            html += '<div class="milestone-line"></div>';

            // Today vertical line
            html += `<div style="position:absolute;left:${todayPct}%;top:0;bottom:0;width:1px;border-left:2px dashed #ef4444;z-index:0"></div>`;

            ms.forEach(m => {
                const d = m.actualEnd || m.plannedEnd || m.plannedStart;
                if (!d) return;
                const pct = Utils.daysBetween(minDate, d) / totalDays * 100;
                const statusCls = m.status === 'completed' ? 'completed' : m.delayDays > 0 ? 'delayed' : '';
                const tooltip = `${m.taskName}\n计划: ${Utils.formatDate(m.plannedStart)} - ${Utils.formatDate(m.plannedEnd)}` +
                    (m.actualEnd ? `\n实际完成: ${Utils.formatDate(m.actualEnd)}` : '') +
                    (m.delayDays > 0 ? `\n延期: ${m.delayDays}天` : '');

                html += `<div class="milestone-item ${statusCls}" style="left:${pct}%" title="${_esc(tooltip)}">
                    <div class="milestone-diamond"></div>
                    <div class="milestone-label">${_esc(m.taskName)}</div>
                    <div class="milestone-date">${Utils.formatDate(d)}</div>
                    ${m.delayDays > 0 ? `<div style="font-size:9px;color:#dc2626">+${m.delayDays}d</div>` : ''}
                </div>`;
            });

            html += '</div></div>';
        });

        html += '</div>';

        // Summary statistics
        const completed = milestones.filter(m => m.status === 'completed').length;
        const delayed = milestones.filter(m => m.delayDays > 0 && m.status !== 'completed').length;
        const onTrack = milestones.length - completed - delayed;

        html += `<div style="display:flex;gap:24px;padding:16px 0;border-top:1px solid #e2e8f0;margin-top:16px">
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#2563eb">${milestones.length}</div><div style="font-size:11px;color:#64748b">总里程碑</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#16a34a">${completed}</div><div style="font-size:11px;color:#64748b">已完成</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#2563eb">${onTrack}</div><div style="font-size:11px;color:#64748b">按计划</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#dc2626">${delayed}</div><div style="font-size:11px;color:#64748b">已延期</div></div>
        </div>`;

        _container.innerHTML = html;
    }

    function _getMonthMarkers(minDate, maxDate, totalDays) {
        const markers = [];
        const d = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
        while (d <= maxDate) {
            const pct = Utils.daysBetween(minDate, d) / totalDays * 100;
            if (pct >= 0 && pct <= 100) {
                markers.push({ pct, label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
            }
            d.setMonth(d.getMonth() + 1);
        }
        return markers;
    }

    function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    return { init, render };
})();
