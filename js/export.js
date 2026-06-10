/* ============================================================
   export.js  –  Export risk reports (HTML-based printable)
   ============================================================ */
const ExportManager = (() => {

    function exportReport() {
        const tasks = DataModel.getTaskList();
        const risks = DataModel.getRisks();
        const projects = DataModel.getProjects();
        const conflicts = DataModel.getResourceConflicts();
        const milestones = DataModel.getMilestones();
        const today = Utils.formatDate(Utils.today());

        const criticalTasks = tasks.filter(t => t.isCritical);
        const delayedTasks = tasks.filter(t => t.delayDays > 0);
        const highRisks = risks.filter(r => r.probability * r.impact >= 15);

        let html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>项目风险报告 - ${today}</title>
<style>
    body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px; color: #1e293b; font-size: 13px; }
    h1 { font-size: 22px; border-bottom: 3px solid #2563eb; padding-bottom: 8px; }
    h2 { font-size: 16px; color: #2563eb; margin-top: 28px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    h3 { font-size: 14px; margin-top: 16px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 12px; }
    th { background: #f1f5f9; padding: 6px 10px; text-align: left; font-weight: 600; border: 1px solid #e2e8f0; }
    td { padding: 5px 10px; border: 1px solid #e2e8f0; }
    .stat-row { display: flex; gap: 20px; margin: 12px 0; }
    .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 20px; text-align: center; flex: 1; }
    .stat-num { font-size: 28px; font-weight: 700; }
    .stat-label { font-size: 11px; color: #64748b; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
    .badge-red { background: #fef2f2; color: #dc2626; }
    .badge-yellow { background: #fffbeb; color: #b45309; }
    .badge-green { background: #f0fdf4; color: #16a34a; }
    .footer { margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 10px; color: #94a3b8; font-size: 11px; text-align: center; }
    @media print { body { padding: 20px; } }
</style>
</head><body>
<h1>多项目进度风险报告</h1>
<p style="color:#64748b">生成日期: ${today}</p>

<h2>一、总体概况</h2>
<div class="stat-row">
    <div class="stat-box"><div class="stat-num">${Object.keys(projects).length}</div><div class="stat-label">项目数</div></div>
    <div class="stat-box"><div class="stat-num">${tasks.length}</div><div class="stat-label">任务总数</div></div>
    <div class="stat-box"><div class="stat-num" style="color:#dc2626">${delayedTasks.length}</div><div class="stat-label">延期任务</div></div>
    <div class="stat-box"><div class="stat-num" style="color:#f59e0b">${criticalTasks.length}</div><div class="stat-label">关键路径任务</div></div>
    <div class="stat-box"><div class="stat-num" style="color:#dc2626">${highRisks.length}</div><div class="stat-label">高风险项</div></div>
    <div class="stat-box"><div class="stat-num" style="color:#dc2626">${conflicts.length}</div><div class="stat-label">资源冲突</div></div>
</div>

<h2>二、项目进度汇总</h2>
<table><tr><th>项目</th><th>任务数</th><th>已完成</th><th>进行中</th><th>延期</th><th>完成率</th><th>里程碑</th></tr>`;

        Object.entries(projects).forEach(([pid, proj]) => {
            const ptasks = tasks.filter(t => t.projectId === pid);
            const done = ptasks.filter(t => t.status === 'completed').length;
            const prog = ptasks.filter(t => t.status === 'in_progress').length;
            const delay = ptasks.filter(t => t.status === 'delayed').length;
            const pct = ptasks.length > 0 ? Math.round(done / ptasks.length * 100) : 0;
            const ms = ptasks.filter(t => t.isMilestone).length;
            html += `<tr><td>${_esc(proj.name)}</td><td>${ptasks.length}</td><td>${done}</td><td>${prog}</td><td>${delay}</td><td>${pct}%</td><td>${ms}</td></tr>`;
        });

        html += '</table>';

        // Delayed tasks
        if (delayedTasks.length > 0) {
            html += '<h2>三、延期任务明细</h2>';
            html += '<table><tr><th>项目</th><th>任务</th><th>负责人</th><th>计划结束</th><th>延期天数</th><th>关键路径</th></tr>';
            delayedTasks.sort((a, b) => b.delayDays - a.delayDays).forEach(t => {
                const projName = projects[t.projectId]?.name || t.projectId;
                html += `<tr><td>${_esc(projName)}</td><td>${_esc(t.taskName)}</td><td>${_esc(t.assignee)}</td>
                    <td>${Utils.formatDate(t.plannedEnd)}</td><td style="color:#dc2626;font-weight:600">+${t.delayDays}天</td>
                    <td>${t.isCritical ? '<span class="badge badge-red">是</span>' : '否'}</td></tr>`;
            });
            html += '</table>';
        }

        // Critical path
        if (criticalTasks.length > 0) {
            html += '<h2>四、关键路径</h2>';
            html += '<table><tr><th>项目</th><th>任务</th><th>负责人</th><th>计划开始</th><th>计划结束</th><th>浮动时间</th></tr>';
            criticalTasks.forEach(t => {
                const projName = projects[t.projectId]?.name || t.projectId;
                html += `<tr><td>${_esc(projName)}</td><td>${_esc(t.taskName)}</td><td>${_esc(t.assignee)}</td>
                    <td>${Utils.formatDate(t.plannedStart)}</td><td>${Utils.formatDate(t.plannedEnd)}</td>
                    <td>${t.totalFloat}天</td></tr>`;
            });
            html += '</table>';
        }

        // Risk matrix
        if (risks.length > 0) {
            html += '<h2>五、风险评估</h2>';
            html += '<table><tr><th>ID</th><th>项目</th><th>描述</th><th>概率</th><th>影响</th><th>得分</th><th>等级</th><th>责任人</th><th>缓解措施</th></tr>';
            risks.sort((a, b) => (b.probability * b.impact) - (a.probability * a.impact)).forEach(r => {
                const score = r.probability * r.impact;
                const level = score >= 15 ? '高' : score >= 8 ? '中' : '低';
                const cls = score >= 15 ? 'badge-red' : score >= 8 ? 'badge-yellow' : 'badge-green';
                const projName = projects[r.projectId]?.name || r.projectId;
                html += `<tr><td>${_esc(r.riskId)}</td><td>${_esc(projName)}</td><td>${_esc(r.description)}</td>
                    <td>${r.probability}</td><td>${r.impact}</td><td style="font-weight:600">${score}</td>
                    <td><span class="badge ${cls}">${level}</span></td><td>${_esc(r.owner)}</td><td>${_esc(r.mitigation)}</td></tr>`;
            });
            html += '</table>';
        }

        // Resource conflicts
        if (conflicts.length > 0) {
            html += '<h2>六、资源冲突</h2>';
            conflicts.forEach(c => {
                html += `<h3>${_esc(c.person)} (${_esc(c.department || '')}） - 最高负荷 ${c.maxAllocation}%</h3>`;
                html += '<table><tr><th>项目</th><th>任务</th><th>投入比例</th><th>时间范围</th></tr>';
                c.allocations.forEach(a => {
                    html += `<tr><td>${_esc(a.projectName)}</td><td>${_esc(a.taskName)}</td><td>${a.allocation}%</td>
                        <td>${Utils.formatDate(a.start)} ~ ${Utils.formatDate(a.end)}</td></tr>`;
                });
                html += '</table>';
            });
        }

        // Milestones
        if (milestones.length > 0) {
            html += '<h2>七、里程碑状态</h2>';
            html += '<table><tr><th>项目</th><th>里程碑</th><th>计划日期</th><th>实际日期</th><th>状态</th><th>延期</th></tr>';
            milestones.forEach(m => {
                const projName = projects[m.projectId]?.name || m.projectId;
                const statusText = m.status === 'completed' ? '已完成' : m.delayDays > 0 ? '延期' : '按计划';
                const cls = m.status === 'completed' ? 'badge-green' : m.delayDays > 0 ? 'badge-red' : 'badge-green';
                html += `<tr><td>${_esc(projName)}</td><td>${_esc(m.taskName)}</td>
                    <td>${Utils.formatDate(m.plannedEnd)}</td><td>${m.actualEnd ? Utils.formatDate(m.actualEnd) : '-'}</td>
                    <td><span class="badge ${cls}">${statusText}</span></td>
                    <td>${m.delayDays > 0 ? '+' + m.delayDays + '天' : '-'}</td></tr>`;
            });
            html += '</table>';
        }

        html += `<div class="footer">本报告由多项目进度风险管理系统自动生成 | ${today}</div>`;
        html += '</body></html>';

        // Open in new window for printing
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (win) {
            win.onload = () => URL.revokeObjectURL(url);
        } else {
            // Fallback: download
            const a = document.createElement('a');
            a.href = url;
            a.download = `项目风险报告_${today}.html`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    return { exportReport };
})();
