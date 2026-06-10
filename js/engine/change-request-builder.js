// Change Request Builder — Create, manage, and export change request drafts
// that summarise all differences between an active baseline and current state.

const STORAGE_KEY = 'pmo-change-requests';

/* -------------------------------------------------------------------------- */
/*  Utility                                                                    */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  try { return structuredClone(obj); } catch (_) { /* fallback */ }
  return JSON.parse(JSON.stringify(obj));
}

function escapeCSV(val) {
  const s = String(val ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/*  ChangeRequestBuilder                                                       */
/* -------------------------------------------------------------------------- */

export class ChangeRequestBuilder {
  /**
   * @param {import('../core/store.js').Store} store
   * @param {import('../core/baseline-manager.js').BaselineManager} baselineManager
   * @param {import('./change-impact-engine.js').ChangeImpactEngine} changeImpactEngine
   */
  constructor(store, baselineManager, changeImpactEngine) {
    this._store = store;
    this._baselineManager = baselineManager;
    this._impactEngine = changeImpactEngine;
    /** @type {Map<string, object>} */
    this._drafts = new Map();
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a change request draft from the current diff.
   * @param {string} [title]
   * @param {string} [description]
   * @returns {string} draft id
   */
  createDraft(title, description) {
    const diff = this._impactEngine.getLastDiff();
    if (!diff) return null;

    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 12);

    const baseline = this._baselineManager.getBaseline(diff.baselineId);

    const draft = {
      id,
      baselineId: diff.baselineId,
      baselineName: baseline ? baseline.name : '',
      title: title || `CR-${new Date().toISOString().slice(0, 10)}-${this._drafts.size + 1}`,
      description: description || '',
      createdAt: Date.now(),
      createdBy: '',
      diff: deepClone(diff),
      summary: deepClone(diff.summary),
      status: 'draft',
    };

    this._drafts.set(id, draft);
    this.saveToStorage();
    return id;
  }

  getDraft(id) {
    return this._drafts.has(id) ? deepClone(this._drafts.get(id)) : null;
  }

  getAllDrafts() {
    return Array.from(this._drafts.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(deepClone);
  }

  deleteDraft(id) {
    if (!this._drafts.has(id)) return false;
    this._drafts.delete(id);
    this.saveToStorage();
    return true;
  }

  updateDraftStatus(id, status) {
    const draft = this._drafts.get(id);
    if (!draft) return false;
    const valid = ['draft', 'submitted', 'approved', 'rejected'];
    if (!valid.includes(status)) return false;
    draft.status = status;
    this.saveToStorage();
    return true;
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  exportAsJSON(draftId) {
    const draft = this._drafts.get(draftId);
    if (!draft) return null;
    return JSON.stringify(draft, null, 2);
  }

  exportAsCSV(draftId) {
    const draft = this._drafts.get(draftId);
    if (!draft) return null;

    const rows = [];
    rows.push(['Section', 'Field', 'Value']);
    rows.push(['Summary', 'Title', draft.title]);
    rows.push(['Summary', 'Baseline', draft.baselineName]);
    rows.push(['Summary', 'Status', draft.status]);
    rows.push(['Summary', 'Created', new Date(draft.createdAt).toISOString()]);

    const s = draft.summary;
    rows.push(['Summary', 'Tasks Changed', s.totalTasksChanged]);
    rows.push(['Summary', 'Total Delay Days', s.totalDelayDays]);
    rows.push(['Summary', 'CP Added', s.criticalPathAdded]);
    rows.push(['Summary', 'CP Removed', s.criticalPathRemoved]);
    rows.push(['Summary', 'Risks Upgraded', s.risksUpgraded]);
    rows.push(['Summary', 'Risks Downgraded', s.risksDowngraded]);
    rows.push(['', '', '']);

    for (const tc of (draft.diff.taskChanges || [])) {
      if (tc.delayDays === 0 && !tc.isNew && !tc.isDeleted && !tc.addedToCriticalPath && !tc.removedFromCriticalPath) continue;
      const cpStatus = tc.addedToCriticalPath ? 'added' : tc.removedFromCriticalPath ? 'removed' : 'unchanged';
      rows.push([
        'Task Change',
        tc.taskName,
        `Delay: ${tc.delayDays > 0 ? '+' : ''}${tc.delayDays}d, CP: ${cpStatus}, Status: ${tc.baselineStatus}→${tc.currentStatus}`,
      ]);
    }

    for (const rc of (draft.diff.riskChanges || [])) {
      rows.push([
        'Risk Change',
        rc.name,
        `${rc.oldLevel}(${rc.oldScore})→${rc.newLevel}(${rc.newScore}) ${rc.direction}`,
      ]);
    }

    return rows.map(row => row.map(escapeCSV).join(',')).join('\n');
  }

  exportAsHTML(draftId) {
    const draft = this._drafts.get(draftId);
    if (!draft) return null;
    return this._generateHTML(draft);
  }

  exportAsMarkdown(draftId) {
    const draft = this._drafts.get(draftId);
    if (!draft) return null;

    const lines = [];
    lines.push(`# Change Request: ${draft.title}`);
    lines.push('');
    lines.push(`- **Baseline:** ${draft.baselineName}`);
    lines.push(`- **Status:** ${draft.status}`);
    lines.push(`- **Created:** ${new Date(draft.createdAt).toLocaleString()}`);
    if (draft.description) {
      lines.push('');
      lines.push(`> ${draft.description}`);
    }
    lines.push('');

    const s = draft.summary;
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Tasks Changed | ${s.totalTasksChanged} |`);
    lines.push(`| Total Delay | ${s.totalDelayDays} days |`);
    lines.push(`| CP Added | ${s.criticalPathAdded} |`);
    lines.push(`| CP Removed | ${s.criticalPathRemoved} |`);
    lines.push(`| New Overloads | ${s.newOverloads} |`);
    lines.push(`| Risks Upgraded | ${s.risksUpgraded} |`);
    lines.push(`| Risks Downgraded | ${s.risksDowngraded} |`);
    lines.push('');

    if (draft.diff.taskChanges?.length > 0) {
      lines.push('## Task Changes');
      lines.push('');
      lines.push('| Task | Delay | CP Change | Status |');
      lines.push('|------|-------|-----------|--------|');
      for (const tc of draft.diff.taskChanges) {
        if (tc.delayDays === 0 && !tc.addedToCriticalPath && !tc.removedFromCriticalPath && !tc.isNew && !tc.isDeleted) continue;
        const delay = tc.delayDays !== 0 ? `${tc.delayDays > 0 ? '+' : ''}${tc.delayDays}d` : '-';
        const cp = tc.addedToCriticalPath ? '+CP' : tc.removedFromCriticalPath ? '-CP' : '-';
        const status = tc.isNew ? 'NEW' : tc.isDeleted ? 'DELETED' : `${tc.baselineStatus}→${tc.currentStatus}`;
        lines.push(`| ${tc.taskName} | ${delay} | ${cp} | ${status} |`);
      }
      lines.push('');
    }

    if (draft.diff.riskChanges?.length > 0) {
      lines.push('## Risk Changes');
      lines.push('');
      lines.push('| Risk | Was | Now | Direction |');
      lines.push('|------|-----|-----|-----------|');
      for (const rc of draft.diff.riskChanges) {
        const arrow = rc.direction === 'upgraded' ? '▲' : rc.direction === 'downgraded' ? '▼' : '-';
        lines.push(`| ${rc.name} | ${rc.oldLevel} (${rc.oldScore}) | ${rc.newLevel} (${rc.newScore}) | ${arrow} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Import a draft from JSON */
  importDraft(jsonString) {
    try {
      const draft = JSON.parse(jsonString);
      if (!draft || !draft.diff || !draft.title) return null;
      draft.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
      draft.status = 'draft';
      this._drafts.set(draft.id, draft);
      this.saveToStorage();
      return draft.id;
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  saveToStorage() {
    try {
      const data = Array.from(this._drafts.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('[ChangeRequestBuilder] localStorage save failed:', err);
    }
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      this._drafts.clear();
      for (const draft of data) {
        if (draft && draft.id && draft.diff) {
          this._drafts.set(draft.id, draft);
        }
      }
    } catch (err) {
      console.warn('[ChangeRequestBuilder] localStorage load failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // HTML generation
  // -------------------------------------------------------------------------

  _generateHTML(draft) {
    const s = draft.summary;
    const d = draft.diff;

    let taskRows = '';
    for (const tc of (d.taskChanges || [])) {
      if (tc.delayDays === 0 && !tc.isNew && !tc.isDeleted && !tc.addedToCriticalPath && !tc.removedFromCriticalPath) continue;
      const delayClass = tc.delayDays > 0 ? 'delay-pos' : tc.delayDays < 0 ? 'delay-neg' : '';
      const cpTag = tc.addedToCriticalPath ? '<span class="cp-add">+CP</span>' : tc.removedFromCriticalPath ? '<span class="cp-rem">-CP</span>' : '';
      taskRows += `<tr>
        <td>${tc.taskName}</td>
        <td class="${delayClass}">${tc.delayDays > 0 ? '+' : ''}${tc.delayDays}d</td>
        <td>${cpTag || '-'}</td>
        <td>${tc.isNew ? 'NEW' : tc.isDeleted ? 'DELETED' : (tc.baselineStatus || '') + ' → ' + (tc.currentStatus || '')}</td>
      </tr>`;
    }

    let riskRows = '';
    for (const rc of (d.riskChanges || [])) {
      const arrow = rc.direction === 'upgraded' ? '▲' : rc.direction === 'downgraded' ? '▼' : '';
      const cls = rc.direction === 'upgraded' ? 'risk-up' : 'risk-down';
      riskRows += `<tr class="${cls}">
        <td>${rc.name}</td>
        <td>${rc.oldLevel} (${rc.oldScore})</td>
        <td>${rc.newLevel} (${rc.newScore})</td>
        <td>${arrow} ${rc.direction}</td>
      </tr>`;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>Change Request: ${draft.title}</title>
<style>
  body{font-family:'Inter',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem;max-width:960px;margin:auto}
  h1{color:#f8fafc;border-bottom:2px solid #3b82f6;padding-bottom:.5rem}
  h2{color:#94a3b8;margin-top:2rem}
  .meta{color:#64748b;font-size:.85rem;margin-bottom:1.5rem}
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin:1rem 0}
  .summary-card{background:#1e293b;border-radius:8px;padding:.75rem;text-align:center}
  .summary-card .val{font-size:1.5rem;font-weight:700;color:#f8fafc}
  .summary-card .lbl{font-size:.75rem;color:#94a3b8}
  table{width:100%;border-collapse:collapse;margin:1rem 0}
  th,td{padding:.5rem .75rem;border-bottom:1px solid #334155;text-align:left;font-size:.85rem}
  th{background:#1e293b;color:#94a3b8;position:sticky;top:0}
  .delay-pos{color:#ef4444;font-weight:600}
  .delay-neg{color:#22c55e;font-weight:600}
  .cp-add{background:#fef2f2;color:#ef4444;padding:2px 6px;border-radius:3px;font-size:.7rem;font-weight:600}
  .cp-rem{background:#f0fdf4;color:#22c55e;padding:2px 6px;border-radius:3px;font-size:.7rem;font-weight:600}
  .risk-up{color:#ef4444}
  .risk-down{color:#22c55e}
  .desc{background:#1e293b;border-left:3px solid #3b82f6;padding:.75rem;margin:1rem 0;border-radius:0 6px 6px 0}
</style></head><body>
<h1>Change Request: ${draft.title}</h1>
<p class="meta">Generated: ${new Date(draft.createdAt).toLocaleString()} | Baseline: ${draft.baselineName} | Status: ${draft.status}</p>
${draft.description ? '<div class="desc">' + draft.description + '</div>' : ''}

<h2>Summary</h2>
<div class="summary-grid">
  <div class="summary-card"><div class="val">${s.totalTasksChanged}</div><div class="lbl">Tasks Changed</div></div>
  <div class="summary-card"><div class="val">${s.totalDelayDays}d</div><div class="lbl">Total Delay</div></div>
  <div class="summary-card"><div class="val">+${s.criticalPathAdded}/-${s.criticalPathRemoved}</div><div class="lbl">Critical Path</div></div>
  <div class="summary-card"><div class="val">${s.newOverloads}</div><div class="lbl">New Overloads</div></div>
  <div class="summary-card"><div class="val">${s.risksUpgraded}</div><div class="lbl">Risks Upgraded</div></div>
  <div class="summary-card"><div class="val">${s.risksDowngraded}</div><div class="lbl">Risks Downgraded</div></div>
</div>

<h2>Task Changes</h2>
<table><thead><tr><th>Task</th><th>Delay</th><th>CP</th><th>Status</th></tr></thead>
<tbody>${taskRows || '<tr><td colspan="4">No task changes</td></tr>'}</tbody></table>

<h2>Risk Changes</h2>
<table><thead><tr><th>Risk</th><th>Was</th><th>Now</th><th>Direction</th></tr></thead>
<tbody>${riskRows || '<tr><td colspan="4">No risk changes</td></tr>'}</tbody></table>

</body></html>`;
  }
}
