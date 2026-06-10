// RiskMatrix - 5x5 probability-impact risk matrix rendered in SVG.
// Displays risk items as circles positioned in matrix cells with a
// detail panel, project filter, and export functionality.

const MATRIX_SIZE = 5;
const CELL_SIZE = 72;
const LABEL_W = 60;
const LABEL_H = 40;

const BG_COLORS = [
  ['#dcfce7', '#dcfce7', '#fef9c3', '#fed7aa', '#fecaca'], // prob 1
  ['#dcfce7', '#fef9c3', '#fef9c3', '#fed7aa', '#fecaca'], // prob 2
  ['#fef9c3', '#fef9c3', '#fed7aa', '#fecaca', '#fecaca'], // prob 3
  ['#fef9c3', '#fed7aa', '#fecaca', '#fecaca', '#fca5a5'], // prob 4
  ['#fed7aa', '#fecaca', '#fecaca', '#fca5a5', '#fca5a5'], // prob 5
];

const PROB_LABELS = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost Certain'];
const IMPACT_LABELS = ['Negligible', 'Minor', 'Moderate', 'Major', 'Critical'];
const RISK_LEVEL_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * RiskMatrix renders a 5x5 SVG grid where each cell is colored by severity.
 * Risk items appear as circles sized by count within their cell. Clicking a
 * cell expands the individual risks; clicking a risk shows full detail.
 */
export class RiskMatrix {
  constructor(container, store, optionsOrEngine) {
    this.container = container;
    this.store = store;
    this.riskEngine = optionsOrEngine?.riskEngine || optionsOrEngine;
    this.baselineManager = optionsOrEngine?.baselineManager || null;

    this._listeners = [];
    this._unsubscribe = null;
    this._selectedCell = null; // {prob, impact}
    this._selectedRisk = null;
    this._filterProject = '';

    this._buildDOM();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderFilter();
    this._renderSummary();
    this._renderMatrix();
    this._renderCellDetail();
    this._renderRiskDetail();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('risk-container');
    this.container.innerHTML = `
      <div class="risk-toolbar">
        <div class="risk-filter"></div>
        <button class="risk-btn risk-export-btn">Export Report</button>
      </div>
      <div class="risk-body">
        <div class="risk-left">
          <div class="risk-summary"></div>
          <div class="risk-matrix-wrap"></div>
        </div>
        <div class="risk-right">
          <div class="risk-cell-detail"></div>
          <div class="risk-item-detail"></div>
        </div>
      </div>
    `;
    this._els = {
      filter: this.container.querySelector('.risk-filter'),
      summary: this.container.querySelector('.risk-summary'),
      matrixWrap: this.container.querySelector('.risk-matrix-wrap'),
      cellDetail: this.container.querySelector('.risk-cell-detail'),
      riskDetail: this.container.querySelector('.risk-item-detail'),
      exportBtn: this.container.querySelector('.risk-export-btn'),
    };

    this._listen(this._els.exportBtn, 'click', () => this._exportReport());
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Filter --------------------------------------------------------------

  _renderFilter() {
    const projects = this.store.getFilteredProjects();
    this._els.filter.innerHTML = `
      <label class="risk-filter-label">Project:
        <select class="risk-filter-select">
          <option value="">All Projects</option>
          ${projects.map((p) => `<option value="${p.id}" ${this._filterProject === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </label>
    `;

    const select = this._els.filter.querySelector('select');
    this._listen(select, 'change', (e) => {
      this._filterProject = e.target.value;
      this._selectedCell = null;
      this._selectedRisk = null;
      this.render();
    });
  }

  // -- Summary -------------------------------------------------------------

  _renderSummary() {
    let summary;
    try {
      summary = this.riskEngine.getProjectRiskSummary();
    } catch {
      this._els.summary.innerHTML = '<p class="risk-empty">Risk data unavailable.</p>';
      return;
    }

    const dist = summary.riskDistribution || {};
    this._els.summary.innerHTML = `
      <div class="risk-stat-card">
        <div class="risk-stat-value">${summary.overallScore || 0}</div>
        <div class="risk-stat-label">Overall Risk Score</div>
      </div>
      <div class="risk-stat-card">
        <div class="risk-stat-value">${(summary.topRisks || []).length}</div>
        <div class="risk-stat-label">Top Risks</div>
      </div>
      <div class="risk-stat-card risk-stat-dist">
        <div class="risk-stat-label">Distribution</div>
        <div class="risk-dist-row"><span class="risk-dist-dot" style="background:#ef4444"></span> Critical: ${dist.critical || 0}</div>
        <div class="risk-dist-row"><span class="risk-dist-dot" style="background:#f97316"></span> High: ${dist.high || 0}</div>
        <div class="risk-dist-row"><span class="risk-dist-dot" style="background:#eab308"></span> Medium: ${dist.medium || 0}</div>
        <div class="risk-dist-row"><span class="risk-dist-dot" style="background:#22c55e"></span> Low: ${dist.low || 0}</div>
      </div>
    `;
  }

  // -- Matrix (SVG) --------------------------------------------------------

  _renderMatrix() {
    const wrap = this._els.matrixWrap;
    wrap.innerHTML = '';

    let risks = this.store.getFilteredRisks();
    if (this._filterProject) {
      risks = risks.filter((r) => r.projectId === this._filterProject);
    }

    // Build baseline risk map for escalation detection
    const baseline = this.baselineManager?.getActiveBaseline?.();
    const baselineRiskMap = new Map();
    if (baseline) {
      for (const r of (baseline.risks || [])) baselineRiskMap.set(r.id, r);
    }
    this._baselineRiskMap = baselineRiskMap;

    // Build cell counts
    const cellCounts = Array.from({ length: MATRIX_SIZE }, () => Array(MATRIX_SIZE).fill(0));
    const cellRisks = Array.from({ length: MATRIX_SIZE }, () => Array.from({ length: MATRIX_SIZE }, () => []));
    for (const r of risks) {
      const pi = Math.max(0, Math.min(MATRIX_SIZE - 1, (r.probability || 1) - 1));
      const ii = Math.max(0, Math.min(MATRIX_SIZE - 1, (r.impact || 1) - 1));
      cellCounts[pi][ii]++;
      cellRisks[pi][ii].push(r);
    }

    const svgW = LABEL_W + MATRIX_SIZE * CELL_SIZE + 10;
    const svgH = LABEL_H + MATRIX_SIZE * CELL_SIZE + 30;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', svgW);
    svg.setAttribute('height', svgH);
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    svg.classList.add('risk-svg');

    // Y-axis label
    const yLabel = document.createElementNS(ns, 'text');
    yLabel.setAttribute('x', 12);
    yLabel.setAttribute('y', LABEL_H + (MATRIX_SIZE * CELL_SIZE) / 2);
    yLabel.setAttribute('transform', `rotate(-90, 12, ${LABEL_H + (MATRIX_SIZE * CELL_SIZE) / 2})`);
    yLabel.setAttribute('text-anchor', 'middle');
    yLabel.setAttribute('fill', '#475569');
    yLabel.setAttribute('font-size', '12');
    yLabel.textContent = 'Probability';
    svg.appendChild(yLabel);

    // X-axis label
    const xLabel = document.createElementNS(ns, 'text');
    xLabel.setAttribute('x', LABEL_W + (MATRIX_SIZE * CELL_SIZE) / 2);
    xLabel.setAttribute('y', svgH - 4);
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('fill', '#475569');
    xLabel.setAttribute('font-size', '12');
    xLabel.textContent = 'Impact';
    svg.appendChild(xLabel);

    // Grid cells (probability rows top-to-bottom = 5 to 1, impact columns left-to-right = 1 to 5)
    for (let pi = 0; pi < MATRIX_SIZE; pi++) {
      const probIdx = MATRIX_SIZE - 1 - pi; // row 0 = probability 5
      const cy = LABEL_H + pi * CELL_SIZE;

      // Row label
      const rl = document.createElementNS(ns, 'text');
      rl.setAttribute('x', LABEL_W - 6);
      rl.setAttribute('y', cy + CELL_SIZE / 2 + 4);
      rl.setAttribute('text-anchor', 'end');
      rl.setAttribute('fill', '#475569');
      rl.setAttribute('font-size', '10');
      rl.textContent = PROB_LABELS[probIdx];
      svg.appendChild(rl);

      for (let ii = 0; ii < MATRIX_SIZE; ii++) {
        const cx = LABEL_W + ii * CELL_SIZE;
        const count = cellCounts[probIdx][ii];
        const isSelected = this._selectedCell && this._selectedCell.prob === probIdx && this._selectedCell.impact === ii;

        // Cell background
        const rect = document.createElementNS(ns, 'rect');
        Object.entries({
          x: cx, y: cy, width: CELL_SIZE, height: CELL_SIZE,
          fill: BG_COLORS[probIdx][ii],
          stroke: isSelected ? '#1e293b' : '#e2e8f0',
          'stroke-width': isSelected ? 2 : 1,
          rx: 3,
        }).forEach(([k, v]) => rect.setAttribute(k, v));
        rect.style.cursor = count > 0 ? 'pointer' : 'default';
        rect.dataset.prob = probIdx;
        rect.dataset.impact = ii;
        svg.appendChild(rect);

        // Click handler
        if (count > 0) {
          this._listen(rect, 'click', () => {
            this._selectedCell = { prob: probIdx, impact: ii };
            this._selectedRisk = null;
            this.render();
          });
        }

        // Circle sized by count
        if (count > 0) {
          const r = Math.min(8 + count * 3, CELL_SIZE / 2 - 6);
          const circle = document.createElementNS(ns, 'circle');
          Object.entries({
            cx: cx + CELL_SIZE / 2,
            cy: cy + CELL_SIZE / 2,
            r,
            fill: '#334155',
            opacity: 0.7,
          }).forEach(([k, v]) => circle.setAttribute(k, v));
          circle.style.pointerEvents = 'none';
          svg.appendChild(circle);

          // Count label
          const cl = document.createElementNS(ns, 'text');
          cl.setAttribute('x', cx + CELL_SIZE / 2);
          cl.setAttribute('y', cy + CELL_SIZE / 2 + 4);
          cl.setAttribute('text-anchor', 'middle');
          cl.setAttribute('fill', '#fff');
          cl.setAttribute('font-size', '11');
          cl.setAttribute('font-weight', 'bold');
          cl.textContent = count;
          svg.appendChild(cl);

          // Escalation markers — check if any risk in this cell escalated
          if (baselineRiskMap.size > 0) {
            let escalatedCount = 0;
            let deescalatedCount = 0;
            for (const risk of cellRisks[probIdx][ii]) {
              const baseRisk = baselineRiskMap.get(risk.id);
              if (baseRisk) {
                const bLevel = RISK_LEVEL_ORDER[baseRisk.level] ?? 0;
                const cLevel = RISK_LEVEL_ORDER[risk.level] ?? 0;
                if (cLevel > bLevel) escalatedCount++;
                else if (cLevel < bLevel) deescalatedCount++;
              }
            }
            if (escalatedCount > 0) {
              // Red upward triangle
              const tx = cx + CELL_SIZE / 2 + r + 3;
              const ty = cy + CELL_SIZE / 2 - 6;
              const tri = document.createElementNS(ns, 'polygon');
              tri.setAttribute('points', `${tx},${ty} ${tx + 5},${ty + 8} ${tx - 5},${ty + 8}`);
              tri.setAttribute('fill', '#ef4444');
              tri.classList.add('risk-escalation-marker');
              tri.style.pointerEvents = 'none';
              svg.appendChild(tri);
            }
            if (deescalatedCount > 0) {
              // Green downward triangle
              const tx = cx + CELL_SIZE / 2 + r + 3;
              const ty = cy + CELL_SIZE / 2 + 6;
              const tri = document.createElementNS(ns, 'polygon');
              tri.setAttribute('points', `${tx - 5},${ty - 8} ${tx + 5},${ty - 8} ${tx},${ty}`);
              tri.setAttribute('fill', '#22c55e');
              tri.classList.add('risk-deescalation-marker');
              tri.style.pointerEvents = 'none';
              svg.appendChild(tri);
            }
          }
        }
      }
    }

    // Column labels (impact)
    for (let ii = 0; ii < MATRIX_SIZE; ii++) {
      const cl = document.createElementNS(ns, 'text');
      cl.setAttribute('x', LABEL_W + ii * CELL_SIZE + CELL_SIZE / 2);
      cl.setAttribute('y', LABEL_H - 8);
      cl.setAttribute('text-anchor', 'middle');
      cl.setAttribute('fill', '#475569');
      cl.setAttribute('font-size', '10');
      cl.textContent = IMPACT_LABELS[ii];
      svg.appendChild(cl);
    }

    wrap.appendChild(svg);
  }

  // -- Cell detail ---------------------------------------------------------

  _renderCellDetail() {
    const panel = this._els.cellDetail;
    if (!this._selectedCell) {
      panel.innerHTML = '<p class="risk-empty">Click a cell to view risks.</p>';
      return;
    }

    const { prob, impact } = this._selectedCell;
    let risks = this.store.getFilteredRisks();
    if (this._filterProject) risks = risks.filter((r) => r.projectId === this._filterProject);

    const cellRisks = risks.filter(
      (r) => (r.probability || 1) - 1 === prob && (r.impact || 1) - 1 === impact
    );

    panel.innerHTML = `
      <h4 class="risk-detail-title">${PROB_LABELS[prob]} / ${IMPACT_LABELS[impact]} (${cellRisks.length} risks)</h4>
      <ul class="risk-cell-list">
        ${cellRisks.map((r) => `
          <li class="risk-cell-item ${this._selectedRisk === r.id ? 'risk-cell-item--selected' : ''}" data-risk-id="${r.id}">
            <span class="risk-cell-name">${r.name}</span>
            <span class="risk-cell-level risk-level--${r.level || 'unknown'}">${r.level || '?'}</span>
          </li>
        `).join('')}
      </ul>
    `;

    // Click handlers for risk items
    panel.querySelectorAll('.risk-cell-item').forEach((el) => {
      this._listen(el, 'click', () => {
        this._selectedRisk = el.dataset.riskId;
        this.render();
      });
    });
  }

  // -- Risk detail ---------------------------------------------------------

  _renderRiskDetail() {
    const panel = this._els.riskDetail;
    if (!this._selectedRisk) {
      panel.innerHTML = '<p class="risk-empty">Select a risk for details.</p>';
      return;
    }

    const risk = this.store.state.risks.get(this._selectedRisk);
    if (!risk) { panel.innerHTML = ''; return; }

    const project = this.store.state.projects.get(risk.projectId);

    // Baseline comparison
    let baselineSection = '';
    const baseRisk = this._baselineRiskMap?.get(risk.id);
    if (baseRisk) {
      const bLevel = RISK_LEVEL_ORDER[baseRisk.level] ?? 0;
      const cLevel = RISK_LEVEL_ORDER[risk.level] ?? 0;
      const changeDir = cLevel > bLevel ? 'Escalated' : cLevel < bLevel ? 'De-escalated' : 'Unchanged';
      const changeColor = cLevel > bLevel ? '#dc2626' : cLevel < bLevel ? '#16a34a' : '#64748b';
      baselineSection = `
        <div class="risk-detail-section risk-baseline-compare">
          <strong>vs Baseline:</strong>
          <div class="risk-detail-grid" style="margin-top:4px">
            <div class="risk-detail-label">Level</div><div><span class="risk-level--${baseRisk.level}">${baseRisk.level}</span> &rarr; <span class="risk-level--${risk.level}">${risk.level}</span></div>
            <div class="risk-detail-label">P &times; I</div><div>${baseRisk.probability}&times;${baseRisk.impact} &rarr; ${risk.probability}&times;${risk.impact}</div>
            <div class="risk-detail-label">Change</div><div style="color:${changeColor};font-weight:600">${changeDir}</div>
          </div>
        </div>
      `;
    }

    panel.innerHTML = `
      <h4 class="risk-detail-title">${risk.name}</h4>
      <div class="risk-detail-grid">
        <div class="risk-detail-label">Project</div><div>${project ? project.name : 'N/A'}</div>
        <div class="risk-detail-label">Probability</div><div>${risk.probability} / 5</div>
        <div class="risk-detail-label">Impact</div><div>${risk.impact} / 5</div>
        <div class="risk-detail-label">Level</div><div><span class="risk-level--${risk.level}">${risk.level}</span></div>
        <div class="risk-detail-label">Category</div><div>${risk.category || 'N/A'}</div>
        <div class="risk-detail-label">Status</div><div>${risk.status || 'Open'}</div>
        <div class="risk-detail-label">Owner</div><div>${risk.owner || 'Unassigned'}</div>
      </div>
      <div class="risk-detail-section">
        <strong>Mitigation:</strong>
        <p>${risk.mitigation || 'No mitigation plan defined.'}</p>
      </div>
      ${baselineSection}
    `;
  }

  // -- Export --------------------------------------------------------------

  _exportReport() {
    try {
      const html = this.riskEngine.exportReportHTML();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'risk-report.html';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export risk report:', err);
    }
  }
}
