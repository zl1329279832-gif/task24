/**
 * RiskEngine — risk matrix computation, scoring, trend analysis,
 * project-level summaries, and report generation (text + HTML).
 */

// ─── Constants ───────────────────────────────────────────────────────
const LEVELS = { low: 'low', medium: 'medium', high: 'high', critical: 'critical' };

const STATUS_WEIGHTS = {
  open: 1.5,
  identified: 1.3,
  active: 1.3,
  mitigating: 1.0,
  mitigated: 0.7,
  monitoring: 1.0,
  closed: 0.3,
  accepted: 0.5,
};
const DEFAULT_STATUS_WEIGHT = 1.0;

const LEVEL_COLORS = { low: '#4caf50', medium: '#ff9800', high: '#f44336', critical: '#b71c1c' };

// ─── Utility helpers ─────────────────────────────────────────────────

/** Score from 1–25 → level string. */
function scoreToLevel(score) {
  if (score <= 6) return LEVELS.low;
  if (score <= 12) return LEVELS.medium;
  if (score <= 19) return LEVELS.high;
  return LEVELS.critical;
}

/** Level string → numeric midpoint for aggregation. */
function levelToScore(level) {
  switch (level) {
    case LEVELS.low: return 3.5;
    case LEVELS.medium: return 9.5;
    case LEVELS.high: return 16;
    case LEVELS.critical: return 22.5;
    default: return 0;
  }
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function getWeight(status) {
  return STATUS_WEIGHTS[(status ?? '').toLowerCase()] ?? DEFAULT_STATUS_WEIGHT;
}

function levelIndex(level) {
  return [LEVELS.low, LEVELS.medium, LEVELS.high, LEVELS.critical].indexOf(level);
}

// ─── Engine ──────────────────────────────────────────────────────────
export class RiskEngine {
  constructor(store) {
    this._store = store;
  }

  // ── 5×5 Risk Matrix ──────────────────────────────────────────────
  calculateMatrix() {
    const risks = [...this._store.state.risks.values()];
    const matrix = [];
    const summary = { low: 0, medium: 0, high: 0, critical: 0, total: 0 };

    for (let p = 5; p >= 1; p--) {
      const row = [];
      for (let i = 1; i <= 5; i++) {
        const score = p * i;
        const level = scoreToLevel(score);
        const cellRisks = risks.filter((r) => r.probability === p && r.impact === i);
        row.push({
          probability: p,
          impact: i,
          risks: cellRisks,
          count: cellRisks.length,
          level,
        });
        summary[level] += cellRisks.length;
        summary.total += cellRisks.length;
      }
      matrix.push(row);
    }

    return { matrix, summary };
  }

  // ── Risk Scores ──────────────────────────────────────────────────
  calculateRiskScores(projectId) {
    const risks = this._getRisks(projectId);

    return risks
      .map((risk) => {
        const score = (risk.probability ?? 0) * (risk.impact ?? 0);
        return {
          riskId: risk.id,
          name: risk.name,
          score,
          level: scoreToLevel(score),
          probability: risk.probability,
          impact: risk.impact,
          priority: risk.priority ?? scoreToLevel(score),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ── Project Risk Summary ─────────────────────────────────────────
  getProjectRiskSummary(projectId) {
    const risks = this._getRisks(projectId);
    if (risks.length === 0) {
      return {
        overallScore: 0,
        overallLevel: LEVELS.low,
        topRisks: [],
        riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
        categoryBreakdown: new Map(),
      };
    }

    // Weighted average score
    let weightedSum = 0;
    let weightTotal = 0;
    const dist = { low: 0, medium: 0, high: 0, critical: 0 };
    const catMap = new Map();

    for (const risk of risks) {
      const score = (risk.probability ?? 0) * (risk.impact ?? 0);
      const weight = getWeight(risk.status);
      weightedSum += score * weight;
      weightTotal += weight;

      const level = scoreToLevel(score);
      dist[level]++;

      const cat = risk.category ?? 'Uncategorized';
      if (!catMap.has(cat)) catMap.set(cat, { count: 0, totalScore: 0 });
      const entry = catMap.get(cat);
      entry.count++;
      entry.totalScore += score;
    }

    const overallScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // Category breakdown with average scores
    const categoryBreakdown = new Map();
    for (const [cat, info] of catMap) {
      categoryBreakdown.set(cat, {
        count: info.count,
        averageScore: Math.round((info.totalScore / info.count) * 100) / 100,
      });
    }

    // Top risks (up to 5)
    const topRisks = [...risks]
      .map((r) => ({ risk: r, score: (r.probability ?? 0) * (r.impact ?? 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((e) => e.risk);

    return {
      overallScore: Math.round(overallScore * 100) / 100,
      overallLevel: scoreToLevel(Math.round(overallScore)),
      topRisks,
      riskDistribution: dist,
      categoryBreakdown,
    };
  }

  // ── Risk Trends ──────────────────────────────────────────────────
  getRiskTrends(periods = 6) {
    const risks = [...this._store.state.risks.values()];
    if (risks.length === 0 || periods <= 0) return [];

    // Determine date range from projects
    const projects = [...this._store.state.projects.values()];
    let globalStart = null;
    let globalEnd = null;

    for (const p of projects) {
      const s = parseDate(p.startDate);
      const e = parseDate(p.endDate);
      if (s && (!globalStart || s < globalStart)) globalStart = s;
      if (e && (!globalEnd || e > globalEnd)) globalEnd = e;
    }

    if (!globalStart || !globalEnd || globalEnd <= globalStart) {
      // Fallback: single period representing now
      const dist = this._countByLevel(risks);
      return [{ period: this._periodLabel(new Date()), ...dist }];
    }

    const totalMs = globalEnd.getTime() - globalStart.getTime();
    const periodMs = totalMs / periods;
    const trends = [];

    for (let i = 0; i < periods; i++) {
      const pStart = new Date(globalStart.getTime() + i * periodMs);
      const pEnd = new Date(globalStart.getTime() + (i + 1) * periodMs);

      // A risk is "active" in a period if its project is active in that period
      // and the risk was created before the period end
      const activeRisks = risks.filter((r) => {
        const project = this._store.state.projects.get(r.projectId);
        if (!project) return true;
        const pS = parseDate(project.startDate);
        const pE = parseDate(project.endDate);
        if (!pS || !pE) return true;
        return pS < pEnd && pE > pStart;
      });

      const dist = this._countByLevel(activeRisks);
      trends.push({ period: this._periodLabel(pStart), ...dist });
    }

    return trends;
  }

  // ── Report generation ────────────────────────────────────────────
  generateReport(projectId) {
    const projects = projectId
      ? [this._store.state.projects.get(projectId)].filter(Boolean)
      : [...this._store.state.projects.values()];

    const risks = this._getRisks(projectId);
    const { matrix, summary } = this.calculateMatrix();
    const scored = this.calculateRiskScores(projectId);
    const topRisks = scored.slice(0, 10);

    // Per-project risk info
    const projectEntries = projects.map((p) => {
      const pRisks = risks.filter((r) => r.projectId === p.id);
      const avgScore =
        pRisks.length > 0
          ? pRisks.reduce((s, r) => s + (r.probability ?? 0) * (r.impact ?? 0), 0) / pRisks.length
          : 0;
      return {
        name: p.name,
        riskScore: Math.round(avgScore * 100) / 100,
        level: scoreToLevel(Math.round(avgScore)),
      };
    });

    // Mitigation status
    const mitigation = this._mitigationStatus(risks);

    // Recommendations
    const recommendations = this._generateRecommendations(risks, projects, summary);

    return {
      title: projectId
        ? `Risk Report — ${projects[0]?.name ?? projectId}`
        : 'Portfolio Risk Report',
      generatedAt: new Date().toISOString(),
      projects: projectEntries,
      riskMatrix: { matrix, summary },
      topRisks: topRisks.map((t) => {
        const orig = risks.find((r) => r.id === t.riskId);
        return {
          id: t.riskId,
          name: t.name,
          score: t.score,
          level: t.level,
          probability: t.probability,
          impact: t.impact,
          status: orig?.status || '',
          owner: orig?.owner || '',
        };
      }),
      recommendations,
      mitigationStatus: mitigation,
    };
  }

  // ── Export: text ──────────────────────────────────────────────────
  exportReportText(projectId) {
    const report = this.generateReport(projectId);
    const lines = [];
    const hr = '═'.repeat(60);

    lines.push(hr);
    lines.push(`  ${report.title}`);
    lines.push(`  Generated: ${new Date(report.generatedAt).toLocaleString()}`);
    lines.push(hr, '');

    // Summary
    const { summary } = report.riskMatrix;
    lines.push('RISK SUMMARY');
    lines.push('─'.repeat(40));
    lines.push(`  Total risks : ${summary.total}`);
    lines.push(`  Critical    : ${summary.critical}`);
    lines.push(`  High        : ${summary.high}`);
    lines.push(`  Medium      : ${summary.medium}`);
    lines.push(`  Low         : ${summary.low}`);
    lines.push('');

    // Projects
    if (report.projects.length > 0) {
      lines.push('PROJECTS');
      lines.push('─'.repeat(40));
      for (const p of report.projects) {
        lines.push(`  ${p.name}: score ${p.riskScore} (${p.level})`);
      }
      lines.push('');
    }

    // Top risks
    if (report.topRisks.length > 0) {
      lines.push('TOP RISKS');
      lines.push('─'.repeat(40));
      report.topRisks.forEach((r, i) => {
        lines.push(`  ${i + 1}. ${r.name} — score ${r.score} [${r.level}] (P${r.probability}×I${r.impact})`);
      });
      lines.push('');
    }

    // Mitigation
    const m = report.mitigationStatus;
    lines.push('MITIGATION STATUS');
    lines.push('─'.repeat(40));
    lines.push(`  On track    : ${m.onTrack}`);
    lines.push(`  At risk     : ${m.atRisk}`);
    lines.push(`  Overdue     : ${m.overdue}`);
    lines.push(`  Not started : ${m.notStarted}`);
    lines.push('');

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('RECOMMENDATIONS');
      lines.push('─'.repeat(40));
      report.recommendations.forEach((rec, i) => {
        lines.push(`  ${i + 1}. ${rec}`);
      });
      lines.push('');
    }

    lines.push(hr);
    return lines.join('\n');
  }

  // ── Export: HTML ──────────────────────────────────────────────────
  exportReportHTML(projectId) {
    const report = this.generateReport(projectId);
    const { summary } = report.riskMatrix;
    const m = report.mitigationStatus;

    const riskRows = report.topRisks
      .map(
        (r) =>
          `<tr>
            <td>${this._esc(r.name)}</td>
            <td>${r.score}</td>
            <td><span style="color:${LEVEL_COLORS[r.level]}">${r.level.toUpperCase()}</span></td>
            <td>${r.probability}</td>
            <td>${r.impact}</td>
          </tr>`,
      )
      .join('');

    const projectRows = report.projects
      .map(
        (p) =>
          `<tr>
            <td>${this._esc(p.name)}</td>
            <td>${p.riskScore}</td>
            <td><span style="color:${LEVEL_COLORS[p.level]}">${p.level.toUpperCase()}</span></td>
          </tr>`,
      )
      .join('');

    const recItems = report.recommendations.map((r) => `<li>${this._esc(r)}</li>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${this._esc(report.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { border-bottom: 2px solid #333; padding-bottom: .5rem; }
  h2 { margin-top: 2rem; color: #444; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: .5rem .75rem; text-align: left; }
  th { background: #f5f5f5; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1rem 0; }
  .summary-card { padding: 1rem; border-radius: 6px; text-align: center; color: #fff; font-weight: bold; }
  ul { padding-left: 1.5rem; }
  .meta { color: #888; font-size: .9rem; }
</style></head>
<body>
<h1>${this._esc(report.title)}</h1>
<p class="meta">Generated: ${new Date(report.generatedAt).toLocaleString()}</p>

<h2>Risk Summary</h2>
<div class="summary-grid">
  <div class="summary-card" style="background:${LEVEL_COLORS.critical}">Critical: ${summary.critical}</div>
  <div class="summary-card" style="background:${LEVEL_COLORS.high}">High: ${summary.high}</div>
  <div class="summary-card" style="background:${LEVEL_COLORS.medium}">Medium: ${summary.medium}</div>
  <div class="summary-card" style="background:${LEVEL_COLORS.low}">Low: ${summary.low}</div>
</div>
<p>Total risks: <strong>${summary.total}</strong></p>

${projectRows ? `<h2>Projects</h2><table><thead><tr><th>Project</th><th>Score</th><th>Level</th></tr></thead><tbody>${projectRows}</tbody></table>` : ''}

${riskRows ? `<h2>Top Risks</h2><table><thead><tr><th>Name</th><th>Score</th><th>Level</th><th>Probability</th><th>Impact</th></tr></thead><tbody>${riskRows}</tbody></table>` : ''}

<h2>Mitigation Status</h2>
<table><thead><tr><th>On Track</th><th>At Risk</th><th>Overdue</th><th>Not Started</th></tr></thead>
<tbody><tr><td>${m.onTrack}</td><td>${m.atRisk}</td><td>${m.overdue}</td><td>${m.notStarted}</td></tr></tbody></table>

${recItems ? `<h2>Recommendations</h2><ul>${recItems}</ul>` : ''}
</body></html>`;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Get risks, optionally filtered to a project. */
  _getRisks(projectId) {
    const all = [...this._store.state.risks.values()];
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }

  /** Count risks by level. */
  _countByLevel(risks) {
    const dist = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of risks) {
      const score = (r.probability ?? 0) * (r.impact ?? 0);
      dist[scoreToLevel(score)]++;
    }
    return dist;
  }

  /** Period label for trend charts. */
  _periodLabel(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  /** Compute mitigation status buckets from risk list. */
  _mitigationStatus(risks) {
    const result = { onTrack: 0, atRisk: 0, overdue: 0, notStarted: 0 };
    const now = Date.now();

    for (const risk of risks) {
      const status = (risk.status ?? '').toLowerCase();
      const hasMitigation = !!(risk.mitigation && risk.mitigation.trim().length > 0);

      if (status === 'closed' || status === 'accepted') {
        result.onTrack++;
      } else if (!hasMitigation) {
        result.notStarted++;
      } else if (status === 'mitigated' || status === 'mitigating') {
        // Check if mitigation deadline has passed
        const deadline = parseDate(risk.mitigationDeadline);
        if (deadline && deadline.getTime() < now) {
          result.overdue++;
        } else {
          result.onTrack++;
        }
      } else if (status === 'open' || status === 'identified' || status === 'active') {
        const score = (risk.probability ?? 0) * (risk.impact ?? 0);
        if (score >= 13) {
          result.atRisk++;
        } else {
          result.notStarted++;
        }
      } else {
        result.notStarted++;
      }
    }

    return result;
  }

  /** Auto-generate actionable recommendations based on risk patterns. */
  _generateRecommendations(risks, projects, summary) {
    const recs = [];

    // Critical risks
    if (summary.critical > 0) {
      recs.push(
        `${summary.critical} critical risk(s) detected — immediate executive review and escalation recommended.`,
      );
    }

    // Risks without mitigation
    const noMitigation = risks.filter(
      (r) => !r.mitigation || r.mitigation.trim().length === 0,
    );
    if (noMitigation.length > 0) {
      recs.push(
        `${noMitigation.length} risk(s) have no mitigation plan — assign owners and define mitigation strategies.`,
      );
    }

    // Department concentration
    const deptCounts = new Map();
    for (const risk of risks) {
      const project = this._store.state.projects.get(risk.projectId);
      const dept = project?.department ?? 'Unknown';
      deptCounts.set(dept, (deptCounts.get(dept) ?? 0) + 1);
    }
    for (const [dept, count] of deptCounts) {
      if (count >= 3) {
        const highImpact = risks.filter((r) => {
          const p = this._store.state.projects.get(r.projectId);
          return (p?.department === dept) && (r.impact ?? 0) >= 4;
        }).length;
        if (highImpact >= 2) {
          recs.push(
            `Multiple high-impact risks concentrated in ${dept} — consider department-level risk review and additional oversight.`,
          );
        }
      }
    }

    // Risks without owners
    const noOwner = risks.filter((r) => !r.owner || r.owner.trim().length === 0);
    if (noOwner.length > 0) {
      recs.push(`${noOwner.length} risk(s) lack an assigned owner — assign risk owners to ensure accountability.`);
    }

    // Open high/critical risks
    const openHigh = risks.filter((r) => {
      const score = (r.probability ?? 0) * (r.impact ?? 0);
      const status = (r.status ?? '').toLowerCase();
      return score >= 13 && (status === 'open' || status === 'identified' || status === 'active');
    });
    if (openHigh.length > 0) {
      recs.push(
        `${openHigh.length} high/critical risk(s) remain open — prioritize mitigation actions and weekly tracking.`,
      );
    }

    // Single project with disproportionate risk
    if (projects.length > 1) {
      const projRiskCounts = new Map();
      for (const r of risks) {
        projRiskCounts.set(r.projectId, (projRiskCounts.get(r.projectId) ?? 0) + 1);
      }
      const total = risks.length;
      for (const [pid, count] of projRiskCounts) {
        if (count > total * 0.5 && total > 3) {
          const project = this._store.state.projects.get(pid);
          recs.push(
            `Project "${project?.name ?? pid}" holds ${Math.round((count / total) * 100)}% of all risks — evaluate scope and risk distribution.`,
          );
          break;
        }
      }
    }

    if (recs.length === 0) {
      recs.push('No critical recommendations at this time. Continue monitoring risk status.');
    }

    return recs;
  }

  /** Minimal HTML escaping. */
  _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
