/**
 * change-request.js
 * Manages change request drafts that capture the impact of modifications
 * relative to a baseline version.
 *
 * Each change request stores a snapshot of the computed impacts at the
 * time of creation, allowing PMOs to review and approve/reject changes.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'cr-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

const STORAGE_KEY = 'pmo-change-requests';

// ---------------------------------------------------------------------------
// ChangeRequestManager
// ---------------------------------------------------------------------------

export class ChangeRequestManager {
  /**
   * @param {import('./store.js').Store} store
   * @param {import('./baseline-manager.js').BaselineManager} baselineManager
   * @param {import('../engine/change-impact-engine.js').ChangeImpactEngine} changeImpactEngine
   */
  constructor(store, baselineManager, changeImpactEngine) {
    this._store = store;
    this._baselineManager = baselineManager;
    this._changeImpactEngine = changeImpactEngine;

    /** @type {Map<string, ChangeRequest>} */
    this._requests = new Map();

    /** Subscribers */
    this._subscribers = [];
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  subscribe(listener) {
    this._subscribers.push(listener);
    return () => {
      const idx = this._subscribers.indexOf(listener);
      if (idx !== -1) this._subscribers.splice(idx, 1);
    };
  }

  _emit(event) {
    for (const fn of this._subscribers) {
      try { fn(event); } catch (e) { console.error('ChangeRequestManager subscriber error:', e); }
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a change request draft with auto-computed impacts from the
   * active baseline.
   * @param {string} title
   * @param {string} [description]
   * @param {string} [requestor]
   * @returns {{id: string, error?: string}}
   */
  createDraft(title, description, requestor) {
    const baselineSnapshot = this._baselineManager.getActiveBaseline();
    if (!baselineSnapshot) {
      return { id: null, error: 'No active baseline selected for comparison' };
    }

    const baselineInfo = this._baselineManager.getActiveBaselineInfo();
    const impacts = this._changeImpactEngine.calculateImpact(baselineSnapshot);

    const id = uid();
    const request = {
      id,
      title: title || 'Change Request',
      description: description || '',
      requestor: requestor || '',
      createdAt: new Date().toISOString(),
      status: 'draft',
      baselineId: baselineInfo.id,
      baselineName: baselineInfo.name,
      impacts: deepClone(impacts),
    };

    this._requests.set(id, request);
    this._emit({ type: 'change-request', action: 'create', id });
    return { id };
  }

  /**
   * Get a change request by id (deep-cloned).
   * @param {string} id
   * @returns {ChangeRequest|null}
   */
  getDraft(id) {
    const cr = this._requests.get(id);
    return cr ? deepClone(cr) : null;
  }

  /**
   * Update a change request draft.
   * @param {string} id
   * @param {Object} changes - fields to update (title, description, requestor, status)
   */
  updateDraft(id, changes) {
    const cr = this._requests.get(id);
    if (!cr) return;
    if (changes.title !== undefined) cr.title = changes.title;
    if (changes.description !== undefined) cr.description = changes.description;
    if (changes.requestor !== undefined) cr.requestor = changes.requestor;
    if (changes.status !== undefined) cr.status = changes.status;
    this._emit({ type: 'change-request', action: 'update', id });
  }

  /**
   * Delete a change request.
   * @param {string} id
   */
  deleteDraft(id) {
    if (!this._requests.has(id)) return;
    this._requests.delete(id);
    this._emit({ type: 'change-request', action: 'delete', id });
  }

  /**
   * List all change requests.
   * @returns {Array<{id, title, requestor, createdAt, status, baselineName}>}
   */
  listDrafts() {
    return Array.from(this._requests.values()).map(cr => ({
      id: cr.id,
      title: cr.title,
      requestor: cr.requestor,
      createdAt: cr.createdAt,
      status: cr.status,
      baselineName: cr.baselineName,
    }));
  }

  /**
   * Export a change request as a formatted HTML report.
   * @param {string} id
   * @returns {string|null}
   */
  exportDraft(id) {
    const cr = this._requests.get(id);
    if (!cr) return null;

    const s = cr.impacts.summary;
    const esc = (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const delayRows = cr.impacts.taskDelays
      .filter(d => d.delayDays !== 0 && !d.isNew && !d.isRemoved)
      .sort((a, b) => b.delayDays - a.delayDays)
      .map(d => `<tr><td>${esc(d.taskName)}</td><td>${esc(d.projectName)}</td><td>${d.baselineEnd}</td><td>${d.currentEnd}</td><td style="color:${d.delayDays > 0 ? '#dc2626' : '#16a34a'}">${d.delayDays > 0 ? '+' : ''}${d.delayDays} days</td></tr>`)
      .join('');

    const riskRows = cr.impacts.riskLevelChanges
      .filter(r => r.escalated || r.deescalated)
      .map(r => `<tr><td>${esc(r.riskName)}</td><td>${esc(r.projectName)}</td><td>${r.baselineLevel}</td><td>${r.currentLevel}</td><td>${r.escalated ? 'Escalated' : 'De-escalated'}</td></tr>`)
      .join('');

    const resRows = cr.impacts.resourceOverloadChanges
      .filter(r => r.currentOverloaded !== r.baselineOverloaded)
      .map(r => `<tr><td>${esc(r.resourceName)}</td><td>${r.baselinePeakLoad}%</td><td>${r.currentPeakLoad}%</td><td>${r.currentOverloaded && !r.baselineOverloaded ? 'New Overload' : 'Resolved'}</td></tr>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Change Request: ${esc(cr.title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1e293b}
h1{color:#1e40af;border-bottom:2px solid #3b82f6;padding-bottom:0.5rem}
h2{color:#334155;margin-top:2rem}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left}
th{background:#f1f5f9;font-weight:600}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:1rem 0}
.summary-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;text-align:center}
.summary-card .value{font-size:1.5rem;font-weight:700;color:#1e40af}
.summary-card .label{font-size:0.85rem;color:#64748b;margin-top:0.25rem}
.meta{color:#64748b;font-size:0.9rem}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.8rem;font-weight:600;background:#fef3c7;color:#92400e}
</style></head><body>
<h1>Change Request: ${esc(cr.title)}</h1>
<div class="meta">
  <p>Requestor: ${esc(cr.requestor) || 'N/A'} | Created: ${new Date(cr.createdAt).toLocaleString('zh-CN')} | Status: <span class="status">${cr.status}</span></p>
  <p>Baseline: ${esc(cr.baselineName)}</p>
  ${cr.description ? `<p>Description: ${esc(cr.description)}</p>` : ''}
</div>

<h2>Impact Summary</h2>
<div class="summary-grid">
  <div class="summary-card"><div class="value">${s.totalDelayedTasks}</div><div class="label">Delayed Tasks</div></div>
  <div class="summary-card"><div class="value">${s.maxDelayDays}</div><div class="label">Max Delay (days)</div></div>
  <div class="summary-card"><div class="value">${s.criticalPathLengthDelta > 0 ? '+' : ''}${s.criticalPathLengthDelta}</div><div class="label">Critical Path Delta</div></div>
  <div class="summary-card"><div class="value">${s.newOverloads}</div><div class="label">New Overloads</div></div>
  <div class="summary-card"><div class="value">${s.escalatedRisks}</div><div class="label">Escalated Risks</div></div>
</div>

<h2>Task Delays</h2>
${delayRows ? `<table><thead><tr><th>Task</th><th>Project</th><th>Baseline End</th><th>Current End</th><th>Delay</th></tr></thead><tbody>${delayRows}</tbody></table>` : '<p>No task delays detected.</p>'}

<h2>Risk Level Changes</h2>
${riskRows ? `<table><thead><tr><th>Risk</th><th>Project</th><th>Baseline Level</th><th>Current Level</th><th>Change</th></tr></thead><tbody>${riskRows}</tbody></table>` : '<p>No risk level changes detected.</p>'}

<h2>Resource Overload Changes</h2>
${resRows ? `<table><thead><tr><th>Resource</th><th>Baseline Peak</th><th>Current Peak</th><th>Status</th></tr></thead><tbody>${resRows}</tbody></table>` : '<p>No resource overload changes detected.</p>'}

<h2>Critical Path Changes</h2>
<p>Baseline critical tasks: ${cr.impacts.criticalPathChanges.baselineCritical.length} | Current: ${cr.impacts.criticalPathChanges.currentCritical.length}</p>
<p>Newly critical: ${cr.impacts.criticalPathChanges.added.length} | No longer critical: ${cr.impacts.criticalPathChanges.removed.length}</p>

</body></html>`;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  save() {
    try {
      const data = Array.from(this._requests.values()).map(deepClone);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[ChangeRequestManager] Failed to save:', e);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this._requests.clear();
        for (const cr of data) {
          if (cr.id) this._requests.set(cr.id, deepClone(cr));
        }
      }
    } catch (e) {
      console.warn('[ChangeRequestManager] Failed to load:', e);
    }
  }
}
