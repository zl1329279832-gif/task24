/* ============================================================
   heatmap.js  –  Canvas-based delay heatmap
   ============================================================ */
const HeatmapView = (() => {
    let _canvas, _ctx, _tooltip;
    let _cells = [];
    const CELL_PAD = 2;
    const LABEL_W = 160;
    const HEADER_H = 40;
    const CELL_H = 32;

    function init() {
        _canvas = document.getElementById('heatmap-canvas');
        _ctx = _canvas.getContext('2d');
        _tooltip = document.getElementById('heatmap-tooltip');

        _canvas.addEventListener('mousemove', _onMouseMove);
        _canvas.addEventListener('mouseleave', () => { _tooltip.style.display = 'none'; });

        document.getElementById('heatmap-group').addEventListener('change', () => render(App?.currentFilters));
    }

    function render(filters) {
        const tasks = filters ? DataModel.getFilteredTasks(filters) : DataModel.getTaskList();
        if (tasks.length === 0) {
            _clearCanvas('暂无任务数据');
            return;
        }

        const groupBy = document.getElementById('heatmap-group').value;
        const groups = _groupTasks(tasks, groupBy);
        const dateRange = DataModel.getDateRange();

        // Build week columns
        const weeks = [];
        let d = new Date(dateRange.min);
        d.setDate(d.getDate() - d.getDay()); // align to Sunday
        while (d <= dateRange.max) {
            weeks.push(new Date(d));
            d = Utils.addDays(d, 7);
        }

        const dpr = window.devicePixelRatio || 1;
        const groupNames = Object.keys(groups);
        const canvasW = LABEL_W + weeks.length * (CELL_H + CELL_PAD) + 20;
        const canvasH = HEADER_H + groupNames.length * (CELL_H + CELL_PAD) + 20;

        _canvas.width = canvasW * dpr;
        _canvas.height = canvasH * dpr;
        _canvas.style.width = canvasW + 'px';
        _canvas.style.height = canvasH + 'px';
        _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        _ctx.fillStyle = '#fff';
        _ctx.fillRect(0, 0, canvasW, canvasH);

        _cells = [];

        // Column headers (week dates)
        _ctx.font = '10px -apple-system, sans-serif';
        _ctx.fillStyle = '#64748b';
        _ctx.textAlign = 'center';
        weeks.forEach((w, ci) => {
            const x = LABEL_W + ci * (CELL_H + CELL_PAD) + CELL_H / 2;
            const label = `${w.getMonth() + 1}/${w.getDate()}`;
            _ctx.save();
            _ctx.translate(x, HEADER_H - 4);
            _ctx.rotate(-Math.PI / 4);
            _ctx.fillText(label, 0, 0);
            _ctx.restore();
        });

        // Rows
        groupNames.forEach((gName, ri) => {
            const y = HEADER_H + ri * (CELL_H + CELL_PAD);

            // Row label
            _ctx.fillStyle = '#1e293b';
            _ctx.font = '11px -apple-system, sans-serif';
            _ctx.textAlign = 'right';
            const displayName = gName.length > 18 ? gName.slice(0, 17) + '…' : gName;
            _ctx.fillText(displayName, LABEL_W - 8, y + CELL_H / 2 + 4);

            // Cells
            const groupTasks = groups[gName];
            weeks.forEach((weekStart, ci) => {
                const weekEnd = Utils.addDays(weekStart, 7);
                const x = LABEL_W + ci * (CELL_H + CELL_PAD);

                // Calculate delay intensity for this group in this week
                let totalDelay = 0;
                let taskCount = 0;
                const delayedTaskNames = [];

                groupTasks.forEach(t => {
                    if (!t.plannedStart || !t.plannedEnd) return;
                    const tStart = t.actualStart || t.plannedStart;
                    const tEnd = t.actualEnd || t.plannedEnd;
                    // Check if task overlaps this week
                    if (tStart <= weekEnd && tEnd >= weekStart) {
                        taskCount++;
                        if (t.delayDays > 0) {
                            totalDelay += t.delayDays;
                            delayedTaskNames.push(`${t.taskName}: +${t.delayDays}天`);
                        }
                    }
                });

                const color = _delayColor(totalDelay, taskCount);
                _ctx.fillStyle = color;
                _ctx.fillRect(x, y, CELL_H, CELL_H);

                // Border
                _ctx.strokeStyle = '#e2e8f0';
                _ctx.lineWidth = 1;
                _ctx.strokeRect(x, y, CELL_H, CELL_H);

                // Store cell info for tooltip
                _cells.push({
                    x, y, w: CELL_H, h: CELL_H,
                    group: gName,
                    week: Utils.formatDate(weekStart),
                    taskCount,
                    totalDelay,
                    details: delayedTaskNames
                });

                // Show delay number if significant
                if (totalDelay > 0) {
                    _ctx.fillStyle = totalDelay > 10 ? '#fff' : '#92400e';
                    _ctx.font = 'bold 10px -apple-system, sans-serif';
                    _ctx.textAlign = 'center';
                    _ctx.fillText(totalDelay, x + CELL_H / 2, y + CELL_H / 2 + 4);
                }
            });
        });

        // Legend
        const legendY = canvasH - 16;
        _ctx.font = '10px -apple-system, sans-serif';
        _ctx.fillStyle = '#64748b';
        _ctx.textAlign = 'left';
        _ctx.fillText('延期天数:', 10, legendY);
        const legendColors = [
            { label: '0', color: '#f0fdf4' },
            { label: '1-3', color: '#fef3c7' },
            { label: '4-7', color: '#fbbf24' },
            { label: '8-14', color: '#f59e0b' },
            { label: '15+', color: '#dc2626' }
        ];
        let lx = 70;
        legendColors.forEach(lc => {
            _ctx.fillStyle = lc.color;
            _ctx.fillRect(lx, legendY - 10, 14, 14);
            _ctx.strokeStyle = '#e2e8f0';
            _ctx.strokeRect(lx, legendY - 10, 14, 14);
            _ctx.fillStyle = '#64748b';
            _ctx.fillText(lc.label, lx + 18, legendY);
            lx += 52;
        });
    }

    function _groupTasks(tasks, groupBy) {
        const groups = {};
        tasks.forEach(t => {
            let key;
            switch (groupBy) {
                case 'project': key = t.projectName || t.projectId; break;
                case 'person': key = t.assignee || '未分配'; break;
                case 'dept': key = t.department || '未分组'; break;
                default: key = t.projectId;
            }
            if (!groups[key]) groups[key] = [];
            groups[key].push(t);
        });
        return groups;
    }

    function _delayColor(totalDelay, taskCount) {
        if (taskCount === 0) return '#f8fafc';
        if (totalDelay === 0) return '#f0fdf4';
        if (totalDelay <= 3) return '#fef3c7';
        if (totalDelay <= 7) return '#fbbf24';
        if (totalDelay <= 14) return '#f59e0b';
        return '#dc2626';
    }

    function _onMouseMove(e) {
        const rect = _canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const cell = _cells.find(c => mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h);
        if (cell) {
            let text = `${cell.group}\n周起始: ${cell.week}\n任务数: ${cell.taskCount}\n总延期: ${cell.totalDelay}天`;
            if (cell.details.length > 0) text += '\n\n' + cell.details.join('\n');
            _tooltip.textContent = text;
            _tooltip.style.whiteSpace = 'pre-line';
            _tooltip.style.display = 'block';
            _tooltip.style.left = (e.clientX + 12) + 'px';
            _tooltip.style.top = (e.clientY + 12) + 'px';
        } else {
            _tooltip.style.display = 'none';
        }
    }

    function _clearCanvas(msg) {
        const dpr = window.devicePixelRatio || 1;
        _canvas.width = 600 * dpr;
        _canvas.height = 200 * dpr;
        _canvas.style.width = '600px';
        _canvas.style.height = '200px';
        _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        _ctx.fillStyle = '#fff';
        _ctx.fillRect(0, 0, 600, 200);
        _ctx.fillStyle = '#94a3b8';
        _ctx.font = '14px -apple-system, sans-serif';
        _ctx.textAlign = 'center';
        _ctx.fillText(msg, 300, 100);
    }

    return { init, render };
})();
