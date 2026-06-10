/* ============================================================
   csv-parser.js  –  Robust CSV parser with validation
   ============================================================ */
const CSVParser = (() => {

    function parse(text) {
        if (!text || !text.trim()) return [];
        // Normalize line endings
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '"') {
                if (inQuotes && text[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === '\n' && !inQuotes) {
                lines.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) lines.push(current);

        return lines.map(line => {
            const fields = [];
            let field = '';
            let inQ = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (c === '"') {
                    if (inQ && line[i + 1] === '"') { field += '"'; i++; }
                    else inQ = !inQ;
                } else if (c === ',' && !inQ) {
                    fields.push(field.trim());
                    field = '';
                } else {
                    field += c;
                }
            }
            fields.push(field.trim());
            return fields;
        });
    }

    function parseTasks(text) {
        const rows = parse(text);
        if (rows.length < 2) return { tasks: [], errors: ['任务数据至少需要标题行和一行数据'] };
        const errors = [];
        const tasks = [];
        // Skip header
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (r.length < 4 || r.every(c => !c)) continue;

            const task = {
                projectId: r[0] || ('P_auto_' + i),
                projectName: r[1] || '未命名项目',
                taskId: r[2] || Utils.uid(),
                taskName: r[3] || '未命名任务',
                assignee: r[4] || '',
                department: r[5] || '',
                plannedStart: null,
                plannedEnd: null,
                actualStart: null,
                actualEnd: null,
                status: 'not_started',
                dependencies: [],
                isMilestone: false,
                effort: 100
            };

            // Parse dates with error collection
            task.plannedStart = Utils.parseDate(r[6]);
            task.plannedEnd = Utils.parseDate(r[7]);
            task.actualStart = Utils.parseDate(r[8]);
            task.actualEnd = Utils.parseDate(r[9]);

            if (!task.plannedStart && r[6]) errors.push(`行${i + 1}: 无法解析计划开始日期 "${r[6]}"`);
            if (!task.plannedEnd && r[7]) errors.push(`行${i + 1}: 无法解析计划结束日期 "${r[7]}"`);

            // Auto-fix: if only one planned date, set duration to 1 day
            if (task.plannedStart && !task.plannedEnd) {
                task.plannedEnd = Utils.addDays(task.plannedStart, 1);
                errors.push(`行${i + 1}: 缺少计划结束日期，已默认设为开始日期+1天`);
            }
            if (!task.plannedStart && task.plannedEnd) {
                task.plannedStart = Utils.addDays(task.plannedEnd, -1);
                errors.push(`行${i + 1}: 缺少计划开始日期，已默认设为结束日期-1天`);
            }

            // Status
            const statusMap = {
                '未开始': 'not_started', 'not_started': 'not_started', '未启动': 'not_started',
                '进行中': 'in_progress', 'in_progress': 'in_progress', '进行': 'in_progress',
                '已完成': 'completed', 'completed': 'completed', '完成': 'completed',
                '已延期': 'delayed', 'delayed': 'delayed', '延期': 'delayed'
            };
            const rawStatus = (r[10] || '').toLowerCase().trim();
            task.status = statusMap[rawStatus] || _inferStatus(task);

            // Dependencies (semicolon separated)
            if (r[11]) {
                task.dependencies = r[11].split(/[;；,，]/).map(s => s.trim()).filter(Boolean);
            }

            // Milestone
            const milestoneVal = (r[12] || '').trim().toUpperCase();
            task.isMilestone = milestoneVal === 'Y' || milestoneVal === '是' || milestoneVal === 'YES' || milestoneVal === '1';

            // Effort percentage
            if (r[13]) {
                const eff = parseFloat(r[13]);
                if (!isNaN(eff)) task.effort = Utils.clamp(eff, 0, 100);
            }

            tasks.push(task);
        }
        return { tasks, errors };
    }

    function _inferStatus(task) {
        const now = Utils.today();
        if (task.actualEnd) return 'completed';
        if (task.actualStart) {
            if (task.plannedEnd && now > task.plannedEnd) return 'delayed';
            return 'in_progress';
        }
        if (task.plannedStart && now > task.plannedStart) return 'delayed';
        return 'not_started';
    }

    function parseRisks(text) {
        const rows = parse(text);
        if (rows.length < 2) return { risks: [], errors: ['风险数据至少需要标题行和一行数据'] };
        const errors = [];
        const risks = [];

        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (r.length < 3 || r.every(c => !c)) continue;

            const risk = {
                riskId: r[0] || Utils.uid(),
                projectId: r[1] || '',
                description: r[2] || '未描述',
                probability: Utils.clamp(parseInt(r[3]) || 3, 1, 5),
                impact: Utils.clamp(parseInt(r[4]) || 3, 1, 5),
                owner: r[5] || '',
                mitigation: r[6] || '',
                status: r[7] || 'open'
            };

            if (!r[1]) errors.push(`风险行${i + 1}: 缺少项目ID`);
            risks.push(risk);
        }
        return { risks, errors };
    }

    function parseResources(text) {
        const rows = parse(text);
        if (rows.length < 2) return { resources: [], errors: ['资源数据至少需要标题行和一行数据'] };
        const errors = [];
        const resources = [];

        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (r.length < 4 || r.every(c => !c)) continue;

            const res = {
                person: r[0] || '未知',
                department: r[1] || '',
                projectId: r[2] || '',
                taskId: r[3] || '',
                allocation: Utils.clamp(parseFloat(r[4]) || 100, 0, 100),
                startDate: Utils.parseDate(r[5]),
                endDate: Utils.parseDate(r[6])
            };

            if (!res.startDate && r[5]) errors.push(`资源行${i + 1}: 无法解析开始日期 "${r[5]}"`);
            if (!res.endDate && r[6]) errors.push(`资源行${i + 1}: 无法解析结束日期 "${r[6]}"`);

            resources.push(res);
        }
        return { resources, errors };
    }

    return { parse, parseTasks, parseRisks, parseResources };
})();
