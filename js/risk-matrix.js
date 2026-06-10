/* ============================================================
   risk-matrix.js  –  Probability × Impact risk matrix (SVG)
   ============================================================ */
const RiskMatrixView = (() => {
    let _container;
    const GRID_SIZE = 70;
    const MARGIN = { top: 40, right: 20, bottom: 30, left: 60 };

    function init() {
        _container = document.getElementById('risk-container');
    }

    function render(filters) {
        const risks = DataModel.getRisks();
        const projects = DataModel.getProjects();

        if (risks.length === 0) {
            _container.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">暂无风险数据<br>请导入风险CSV文件</div>';
            return;
        }

        // Filter risks by project if filter is set
        let filteredRisks = risks;
        if (filters?.project) {
            filteredRisks = risks.filter(r => r.projectId === filters.project);
        }

        let html = '<div class="risk-matrix-grid">';
        html += '<h3 style="margin-bottom:12px;font-size:14px">风险矩阵 (概率 × 影响)</h3>';
        html += _renderMatrixSVG(filteredRisks, projects);
        html += _renderLegend();
        html += '</div>';

        html += '<div class="risk-list">';
        html += '<h3 style="margin-bottom:12px;font-size:14px">风险清单</h3>';
        html += _renderRiskTable(filteredRisks, projects);
        html += _renderSummary(filteredRisks);
        html += '</div>';

        _container.innerHTML = html;
    }

    function _renderMatrixSVG(risks, projects) {
        const w = MARGIN.left + 5 * GRID_SIZE + MARGIN.right;
        const h = MARGIN.top + 5 * GRID_SIZE + MARGIN.bottom;

        let svg = `<svg class="risk-matrix-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`;

        // Grid cells with color coding
        for (let p = 5; p >= 1; p--) {
            for (let imp = 1; imp <= 5; imp++) {
                const score = p * imp;
                const x = MARGIN.left + (imp - 1) * GRID_SIZE;
                const y = MARGIN.top + (5 - p) * GRID_SIZE;
                const color = _scoreColor(score);

                svg += `<rect x="${x}" y="${y}" width="${GRID_SIZE}" height="${GRID_SIZE}" fill="${color}" stroke="#fff" stroke-width="2" rx="4"/>`;
                svg += `<text x="${x + GRID_SIZE / 2}" y="${y + GRID_SIZE - 6}" text-anchor="middle" font-size="9" fill="rgba(0,0,0,0.2)">${score}</text>`;
            }
        }

        // Axis labels
        svg += `<text x="${MARGIN.left + 2.5 * GRID_SIZE}" y="${MARGIN.top - 12}" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="600">影响程度 →</text>`;
        svg += `<text x="14" y="${MARGIN.top + 2.5 * GRID_SIZE}" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="600" transform="rotate(-90,14,${MARGIN.top + 2.5 * GRID_SIZE})">发生概率 →</text>`;

        // Axis ticks
        const impactLabels = ['很低', '低', '中', '高', '很高'];
        const probLabels = ['很低', '低', '中', '高', '很高'];
        for (let i = 0; i < 5; i++) {
            const x = MARGIN.left + i * GRID_SIZE + GRID_SIZE / 2;
            svg += `<text x="${x}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#64748b">${impactLabels[i]}</text>`;
        }
        for (let i = 0; i < 5; i++) {
            const y = MARGIN.top + (4 - i) * GRID_SIZE + GRID_SIZE / 2;
            svg += `<text x="${MARGIN.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${probLabels[i]}</text>`;
        }

        // Plot risk dots
        // Group risks at same position to offset them
        const posMap = {};
        risks.forEach(r => {
            const key = `${r.probability}-${r.impact}`;
            if (!posMap[key]) posMap[key] = [];
            posMap[key].push(r);
        });

        Object.entries(posMap).forEach(([key, group]) => {
            const [p, imp] = key.split('-').map(Number);
            const cx = MARGIN.left + (imp - 1) * GRID_SIZE + GRID_SIZE / 2;
            const cy = MARGIN.top + (5 - p) * GRID_SIZE + GRID_SIZE / 2;

            group.forEach((r, idx) => {
                const offset = (idx - (group.length - 1) / 2) * 14;
                const dotX = cx + offset;
                const score = r.probability * r.impact;
                const dotColor = score >= 15 ? '#991b1b' : score >= 8 ? '#92400e' : '#166534';
                const projName = projects[r.projectId]?.name || r.projectId;

                svg += `<circle class="risk-dot" cx="${dotX}" cy="${cy}" r="10" fill="${dotColor}" stroke="#fff" stroke-width="2" opacity="0.9">
                    <title>${_esc(projName)}: ${_esc(r.description)}\n概率:${r.probability} 影响:${r.impact} 得分:${score}</title>
                </circle>`;
                // Project initial letter
                const initial = projName.charAt(0);
                svg += `<text x="${dotX}" y="${cy + 4}" text-anchor="middle" font-size="9" fill="#fff" font-weight="bold" pointer-events="none">${_esc(initial)}</text>`;
            });
        });

        svg += '</svg>';
        return svg;
    }

    function _scoreColor(score) {
        if (score >= 15) return '#fecaca';
        if (score >= 10) return '#fed7aa';
        if (score >= 5) return '#fef3c7';
        return '#dcfce7';
    }

    function _renderLegend() {
        return `<div style="display:flex;gap:16px;margin-top:12px;font-size:11px;color:#64748b">
            <span><span style="display:inline-block;width:12px;height:12px;background:#fecaca;border-radius:2px;vertical-align:middle;margin-right:4px"></span>高风险(≥15)</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:#fed7aa;border-radius:2px;vertical-align:middle;margin-right:4px"></span>中高(10-14)</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:#fef3c7;border-radius:2px;vertical-align:middle;margin-right:4px"></span>中低(5-9)</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:#dcfce7;border-radius:2px;vertical-align:middle;margin-right:4px"></span>低风险(<5)</span>
        </div>`;
    }

    function _renderRiskTable(risks, projects) {
        // Sort by score descending
        const sorted = [...risks].sort((a, b) => (b.probability * b.impact) - (a.probability * a.impact));

        let html = `<table class="risk-table">
            <thead><tr>
                <th>风险ID</th><th>项目</th><th>描述</th><th>概率</th><th>影响</th><th>得分</th><th>等级</th><th>责任人</th><th>缓解措施</th><th>状态</th>
            </tr></thead><tbody>`;

        sorted.forEach(r => {
            const score = r.probability * r.impact;
            const level = score >= 15 ? 'high' : score >= 8 ? 'medium' : 'low';
            const levelText = score >= 15 ? '高' : score >= 8 ? '中' : '低';
            const projName = projects[r.projectId]?.name || r.projectId;

            html += `<tr>
                <td>${_esc(r.riskId)}</td>
                <td>${_esc(projName)}</td>
                <td style="max-width:200px">${_esc(r.description)}</td>
                <td>${r.probability}</td>
                <td>${r.impact}</td>
                <td style="font-weight:600">${score}</td>
                <td><span class="risk-badge risk-${level}">${levelText}</span></td>
                <td>${_esc(r.owner)}</td>
                <td style="max-width:180px;font-size:11px">${_esc(r.mitigation)}</td>
                <td>${_esc(r.status)}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        return html;
    }

    function _renderSummary(risks) {
        const high = risks.filter(r => r.probability * r.impact >= 15).length;
        const medium = risks.filter(r => { const s = r.probability * r.impact; return s >= 8 && s < 15; }).length;
        const low = risks.filter(r => r.probability * r.impact < 8).length;
        const open = risks.filter(r => r.status === 'open' || r.status === '开放').length;

        return `<div style="display:flex;gap:24px;padding:16px 0;border-top:1px solid #e2e8f0;margin-top:16px">
            <div style="text-align:center"><div style="font-size:24px;font-weight:700">${risks.length}</div><div style="font-size:11px;color:#64748b">总风险数</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#dc2626">${high}</div><div style="font-size:11px;color:#64748b">高风险</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#f59e0b">${medium}</div><div style="font-size:11px;color:#64748b">中风险</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#16a34a">${low}</div><div style="font-size:11px;color:#64748b">低风险</div></div>
            <div style="text-align:center"><div style="font-size:24px;font-weight:700;color:#2563eb">${open}</div><div style="font-size:11px;color:#64748b">待处理</div></div>
        </div>`;
    }

    function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    return { init, render };
})();
