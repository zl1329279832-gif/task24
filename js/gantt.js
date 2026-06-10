/* ============================================================
   gantt.js  –  SVG-based Gantt chart with drag support
   ============================================================ */
const GanttChart = (() => {
    const ROW_H = 36;
    const HEADER_H = 50;
    const MIN_COL_W = { day: 36, week: 80, month: 120 };

    let _svg, _sidebar, _wrapper;
    let _zoom = 'week';
    let _showCriticalPath = true;
    let _rows = [];         // ordered list of task objects for display
    let _dateRange = null;
    let _colWidth = 80;
    let _totalDays = 0;
    let _dragState = null;

    function init() {
        _svg = document.getElementById('gantt-svg');
        _sidebar = document.getElementById('gantt-sidebar');
        _wrapper = document.getElementById('gantt-chart-wrapper');

        // Zoom buttons
        document.querySelectorAll('.zoom-btn[data-zoom]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.zoom-btn[data-zoom]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _zoom = btn.dataset.zoom;
                render();
            });
        });
        document.getElementById('btn-today').addEventListener('click', scrollToToday);
        document.getElementById('show-critical-path').addEventListener('change', e => {
            _showCriticalPath = e.target.checked;
            render();
        });

        // Drag handlers on SVG
        _svg.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mouseup', _onMouseUp);

        // Sync sidebar scroll with chart
        _wrapper.addEventListener('scroll', () => {
            _sidebar.scrollTop = _wrapper.scrollTop;
        });
    }

    function render(filters) {
        const tasks = filters ? DataModel.getFilteredTasks(filters) : DataModel.getTaskList();
        if (tasks.length === 0) {
            _sidebar.innerHTML = '<div style="padding:20px;color:#94a3b8;text-align:center">暂无任务数据<br>请导入CSV文件</div>';
            _svg.innerHTML = '';
            return;
        }

        // Group tasks by project
        _rows = [];
        const projects = {};
        tasks.forEach(t => {
            if (!projects[t.projectId]) projects[t.projectId] = [];
            projects[t.projectId].push(t);
        });

        Object.entries(projects).forEach(([pid, ptasks]) => {
            const proj = DataModel.getProjects()[pid];
            _rows.push({ type: 'project', id: pid, name: proj?.name || pid });
            // Sort tasks: milestones last, then by planned start
            ptasks.sort((a, b) => {
                if (a.isMilestone !== b.isMilestone) return a.isMilestone ? 1 : -1;
                const as = a.plannedStart || new Date(9999, 0);
                const bs = b.plannedStart || new Date(9999, 0);
                return as - bs;
            });
            ptasks.forEach(t => _rows.push({ type: t.isMilestone ? 'milestone' : 'task', ...t }));
        });

        _dateRange = DataModel.getDateRange();
        _totalDays = Utils.daysBetween(_dateRange.min, _dateRange.max);

        switch (_zoom) {
            case 'day': _colWidth = MIN_COL_W.day; break;
            case 'week': _colWidth = MIN_COL_W.week; break;
            case 'month': _colWidth = MIN_COL_W.month; break;
        }

        _renderSidebar();
        _renderChart();
    }

    function _renderSidebar() {
        let html = '<div class="gantt-sidebar-header">任务名称</div>';
        _rows.forEach((row, i) => {
            const cls = row.type === 'project' ? 'project-row' : row.type === 'milestone' ? 'milestone-row' : '';
            const statusCls = row.status ? `status-${row.status}` : '';
            const indent = row.type === 'project' ? '' : 'padding-left:24px;';
            html += `<div class="gantt-sidebar-row ${cls}" style="${indent}" data-idx="${i}">
                ${row.type !== 'project' ? `<span class="task-status ${statusCls}"></span>` : ''}
                <span class="task-name" title="${_escHtml(row.taskName || row.name)}">${_escHtml(row.taskName || row.name)}</span>
                ${row.delayDays > 0 ? `<span style="color:var(--danger);font-size:10px;margin-left:4px">+${row.delayDays}d</span>` : ''}
            </div>`;
        });
        _sidebar.innerHTML = html;
    }

    function _renderChart() {
        const svgNS = 'http://www.w3.org/2000/svg';
        // Calculate SVG dimensions
        let svgWidth, totalCols;

        if (_zoom === 'day') {
            totalCols = _totalDays;
            svgWidth = totalCols * _colWidth;
        } else if (_zoom === 'week') {
            totalCols = Math.ceil(_totalDays / 7);
            svgWidth = totalCols * _colWidth;
        } else {
            totalCols = Math.ceil(_totalDays / 30);
            svgWidth = totalCols * _colWidth;
        }

        const svgHeight = HEADER_H + _rows.length * ROW_H + 20;
        _svg.setAttribute('width', svgWidth);
        _svg.setAttribute('height', svgHeight);
        _svg.innerHTML = '';

        // Defs (arrowhead)
        const defs = Utils.createSVGElement('defs');
        const marker = Utils.createSVGElement('marker', {
            id: 'arrowhead', markerWidth: '8', markerHeight: '6', refX: '8', refY: '3', orient: 'auto'
        });
        const markerPath = Utils.createSVGElement('path', { d: 'M0,0 L8,3 L0,6 Z', fill: '#94a3b8' });
        marker.appendChild(markerPath);
        defs.appendChild(marker);

        const markerCrit = Utils.createSVGElement('marker', {
            id: 'arrowhead-crit', markerWidth: '8', markerHeight: '6', refX: '8', refY: '3', orient: 'auto'
        });
        const markerPathCrit = Utils.createSVGElement('path', { d: 'M0,0 L8,3 L0,6 Z', fill: '#ef4444' });
        markerCrit.appendChild(markerPathCrit);
        defs.appendChild(markerCrit);
        _svg.appendChild(defs);

        // Header background
        _svg.appendChild(Utils.createSVGElement('rect', {
            x: 0, y: 0, width: svgWidth, height: HEADER_H, class: 'gantt-header-bg'
        }));

        // Grid lines and header labels
        _renderGrid(svgWidth, svgHeight, totalCols);

        // Today line
        const todayX = _dateToX(Utils.today());
        if (todayX >= 0 && todayX <= svgWidth) {
            _svg.appendChild(Utils.createSVGElement('line', {
                x1: todayX, y1: HEADER_H, x2: todayX, y2: svgHeight,
                class: 'gantt-today'
            }));
            _svg.appendChild(Utils.createSVGElement('text', {
                x: todayX, y: 12, 'text-anchor': 'middle',
                class: 'gantt-header-text', fill: '#ef4444', 'font-weight': 'bold'
            })).textContent = '今天';
        }

        // Render dependency arrows first (behind bars)
        const depGroup = Utils.createSVGElement('g', { class: 'dep-group' });
        _svg.appendChild(depGroup);

        // Render bars
        const barGroup = Utils.createSVGElement('g', { class: 'bar-group' });
        _svg.appendChild(barGroup);

        const taskRowMap = {};
        _rows.forEach((row, i) => {
            if (row.type === 'project') return;
            taskRowMap[row.taskId] = i;
            _renderBar(barGroup, row, i);
        });

        // Render dependency arrows
        _rows.forEach((row, i) => {
            if (row.type === 'project' || !row.dependencies) return;
            row.dependencies.forEach(depId => {
                if (taskRowMap[depId] !== undefined) {
                    _renderDependencyArrow(depGroup, depId, row.taskId, taskRowMap);
                }
            });
        });
    }

    function _renderGrid(svgWidth, svgHeight, totalCols) {
        if (_zoom === 'day') {
            for (let i = 0; i <= _totalDays; i++) {
                const x = i * _colWidth;
                const date = Utils.addDays(_dateRange.min, i);
                const isMonday = date.getDay() === 1;

                _svg.appendChild(Utils.createSVGElement('line', {
                    x1: x, y1: HEADER_H, x2: x, y2: svgHeight,
                    class: isMonday ? 'gantt-grid-line gantt-grid-line-major' : 'gantt-grid-line'
                }));

                if (i % 1 === 0) {
                    const label = `${date.getMonth() + 1}/${date.getDate()}`;
                    const text = Utils.createSVGElement('text', {
                        x: x + _colWidth / 2, y: 38, 'text-anchor': 'middle', class: 'gantt-header-text'
                    });
                    text.textContent = label;
                    _svg.appendChild(text);
                }

                // Month label on first of month
                if (date.getDate() === 1 || i === 0) {
                    const mLabel = Utils.createSVGElement('text', {
                        x: x + 4, y: 16, class: 'gantt-header-text', 'font-weight': 'bold'
                    });
                    mLabel.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月`;
                    _svg.appendChild(mLabel);
                }
            }
        } else if (_zoom === 'week') {
            for (let i = 0; i <= totalCols; i++) {
                const x = i * _colWidth;
                const date = Utils.addDays(_dateRange.min, i * 7);

                _svg.appendChild(Utils.createSVGElement('line', {
                    x1: x, y1: HEADER_H, x2: x, y2: svgHeight,
                    class: date.getDate() <= 7 ? 'gantt-grid-line gantt-grid-line-major' : 'gantt-grid-line'
                }));

                const label = `${date.getMonth() + 1}/${date.getDate()}`;
                const text = Utils.createSVGElement('text', {
                    x: x + _colWidth / 2, y: 38, 'text-anchor': 'middle', class: 'gantt-header-text'
                });
                text.textContent = label;
                _svg.appendChild(text);

                if (date.getDate() <= 7 || i === 0) {
                    const mLabel = Utils.createSVGElement('text', {
                        x: x + 4, y: 16, class: 'gantt-header-text', 'font-weight': 'bold'
                    });
                    mLabel.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月`;
                    _svg.appendChild(mLabel);
                }
            }
        } else {
            for (let i = 0; i <= totalCols; i++) {
                const x = i * _colWidth;
                const date = Utils.addDays(_dateRange.min, i * 30);

                _svg.appendChild(Utils.createSVGElement('line', {
                    x1: x, y1: HEADER_H, x2: x, y2: svgHeight,
                    class: 'gantt-grid-line gantt-grid-line-major'
                }));

                const text = Utils.createSVGElement('text', {
                    x: x + _colWidth / 2, y: 32, 'text-anchor': 'middle', class: 'gantt-header-text'
                });
                text.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月`;
                _svg.appendChild(text);
            }
        }

        // Row separator lines
        for (let i = 0; i <= _rows.length; i++) {
            const y = HEADER_H + i * ROW_H;
            _svg.appendChild(Utils.createSVGElement('line', {
                x1: 0, y1: y, x2: _svg.getAttribute('width'), y2: y,
                stroke: '#f1f5f9', 'stroke-width': 1
            }));
        }
    }

    function _renderBar(group, row, idx) {
        if (!row.plannedStart || !row.plannedEnd) return;

        const y = HEADER_H + idx * ROW_H;
        const barH = row.isMilestone ? 0 : 20;
        const barY = y + (ROW_H - barH) / 2;

        if (row.isMilestone) {
            // Diamond milestone marker
            const cx = _dateToX(row.plannedStart);
            const cy = y + ROW_H / 2;
            const size = 8;
            const diamond = Utils.createSVGElement('polygon', {
                points: `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`,
                class: 'gantt-milestone',
                'data-task-id': row.taskId
            });
            if (row.status === 'completed') diamond.setAttribute('fill', '#16a34a');
            if (row.status === 'delayed') diamond.setAttribute('fill', '#dc2626');
            group.appendChild(diamond);

            // Label
            const label = Utils.createSVGElement('text', {
                x: cx + size + 4, y: cy + 4, class: 'gantt-bar-tooltip'
            });
            label.textContent = Utils.formatDate(row.plannedStart);
            group.appendChild(label);
            return;
        }

        const x1 = _dateToX(row.plannedStart);
        const x2 = _dateToX(row.plannedEnd);
        const w = Math.max(x2 - x1, 4);

        // Planned bar (background)
        const plannedBar = Utils.createSVGElement('rect', {
            x: x1, y: barY, width: w, height: barH,
            class: 'gantt-bar-planned',
            'data-task-id': row.taskId
        });
        group.appendChild(plannedBar);

        // Actual progress bar
        if (row.actualStart) {
            const ax1 = _dateToX(row.actualStart);
            const ax2 = row.actualEnd ? _dateToX(row.actualEnd) : _dateToX(Utils.today());
            const aw = Math.max(ax2 - ax1, 4);
            const actualBar = Utils.createSVGElement('rect', {
                x: ax1, y: barY, width: aw, height: barH,
                class: `gantt-bar-actual ${row.status === 'delayed' ? 'gantt-bar-delayed' : ''}`
            });
            group.appendChild(actualBar);
        }

        // Critical path highlight
        if (_showCriticalPath && row.isCritical) {
            const critBar = Utils.createSVGElement('rect', {
                x: x1 - 1, y: barY - 1, width: w + 2, height: barH + 2,
                fill: 'none', class: 'gantt-bar-critical'
            });
            group.appendChild(critBar);
        }

        // Task label
        if (w > 40) {
            const label = Utils.createSVGElement('text', {
                x: x1 + 4, y: barY + barH / 2 + 4,
                class: 'gantt-bar-label'
            });
            label.textContent = row.taskName.length > (w / 7) ? row.taskName.slice(0, Math.floor(w / 7)) + '…' : row.taskName;
            group.appendChild(label);
        }

        // Drag handles (left and right edges)
        const dragBarGroup = Utils.createSVGElement('g', {
            class: 'gantt-bar', 'data-task-id': row.taskId
        });

        // Full bar drag area (for moving)
        dragBarGroup.appendChild(Utils.createSVGElement('rect', {
            x: x1 + 6, y: barY, width: Math.max(w - 12, 2), height: barH,
            class: 'drag-handle', 'data-drag': 'move'
        }));

        // Left handle (resize start)
        dragBarGroup.appendChild(Utils.createSVGElement('rect', {
            x: x1, y: barY, width: 6, height: barH,
            class: 'drag-handle', 'data-drag': 'start'
        }));

        // Right handle (resize end)
        dragBarGroup.appendChild(Utils.createSVGElement('rect', {
            x: x1 + w - 6, y: barY, width: 6, height: barH,
            class: 'drag-handle', 'data-drag': 'end'
        }));

        group.appendChild(dragBarGroup);
    }

    function _renderDependencyArrow(group, fromId, toId, taskRowMap) {
        const fromIdx = taskRowMap[fromId];
        const toIdx = taskRowMap[toId];
        const fromTask = DataModel.getTask(fromId);
        const toTask = DataModel.getTask(toId);
        if (!fromTask?.plannedEnd || !toTask?.plannedStart) return;

        const x1 = _dateToX(fromTask.plannedEnd);
        const y1 = HEADER_H + fromIdx * ROW_H + ROW_H / 2;
        const x2 = _dateToX(toTask.plannedStart);
        const y2 = HEADER_H + toIdx * ROW_H + ROW_H / 2;

        const midX = x1 + 12;
        const isCritical = _showCriticalPath && fromTask.isCritical && toTask.isCritical;

        const path = Utils.createSVGElement('path', {
            d: `M${x1},${y1} H${midX} V${y2} H${x2}`,
            class: `gantt-dependency ${isCritical ? 'critical' : ''}`,
            'marker-end': isCritical ? 'url(#arrowhead-crit)' : 'url(#arrowhead)'
        });
        group.appendChild(path);
    }

    function _dateToX(date) {
        if (!date || !_dateRange) return 0;
        const days = Utils.daysBetween(_dateRange.min, date);
        if (_zoom === 'day') return days * _colWidth;
        if (_zoom === 'week') return (days / 7) * _colWidth;
        return (days / 30) * _colWidth;
    }

    function _xToDate(x) {
        let days;
        if (_zoom === 'day') days = x / _colWidth;
        else if (_zoom === 'week') days = (x / _colWidth) * 7;
        else days = (x / _colWidth) * 30;
        return Utils.addDays(_dateRange.min, Math.round(days));
    }

    // --- Drag handling ---
    function _onMouseDown(e) {
        const handle = e.target.closest('.drag-handle');
        if (!handle) return;
        const barGroup = handle.closest('.gantt-bar');
        if (!barGroup) return;

        const taskId = barGroup.getAttribute('data-task-id');
        const task = DataModel.getTask(taskId);
        if (!task) return;

        e.preventDefault();
        History.pushState('拖动任务');

        const svgRect = _svg.getBoundingClientRect();
        _dragState = {
            taskId,
            dragType: handle.getAttribute('data-drag'),
            startX: e.clientX,
            origPlannedStart: new Date(task.plannedStart),
            origPlannedEnd: new Date(task.plannedEnd),
            svgLeft: svgRect.left + _wrapper.scrollLeft
        };
        barGroup.classList.add('dragging');
    }

    function _onMouseMove(e) {
        if (!_dragState) return;
        e.preventDefault();

        const dx = e.clientX - _dragState.startX;
        const task = DataModel.getTask(_dragState.taskId);
        if (!task) return;

        let dayDelta;
        if (_zoom === 'day') dayDelta = Math.round(dx / _colWidth);
        else if (_zoom === 'week') dayDelta = Math.round((dx / _colWidth) * 7);
        else dayDelta = Math.round((dx / _colWidth) * 30);

        if (_dragState.dragType === 'move') {
            task.plannedStart = Utils.addDays(_dragState.origPlannedStart, dayDelta);
            task.plannedEnd = Utils.addDays(_dragState.origPlannedEnd, dayDelta);
        } else if (_dragState.dragType === 'start') {
            const newStart = Utils.addDays(_dragState.origPlannedStart, dayDelta);
            if (newStart < task.plannedEnd) task.plannedStart = newStart;
        } else if (_dragState.dragType === 'end') {
            const newEnd = Utils.addDays(_dragState.origPlannedEnd, dayDelta);
            if (newEnd > task.plannedStart) task.plannedEnd = newEnd;
        }

        render(App?.currentFilters);
    }

    function _onMouseUp(e) {
        if (!_dragState) return;
        const taskId = _dragState.taskId;
        _dragState = null;

        document.querySelectorAll('.gantt-bar.dragging').forEach(el => el.classList.remove('dragging'));

        // Reschedule downstream
        Scheduler.rescheduleDownstream(taskId, DataModel.getTasks());
        Scheduler.calculateCPM(DataModel.getTasks());
        render(App?.currentFilters);
    }

    function scrollToToday() {
        const x = _dateToX(Utils.today());
        _wrapper.scrollLeft = Math.max(0, x - _wrapper.clientWidth / 3);
    }

    function _escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return { init, render, scrollToToday };
})();
