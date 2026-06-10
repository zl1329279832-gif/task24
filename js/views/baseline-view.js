// BaselineView — Baseline management and change impact analysis.
// Sidebar for baseline list + main panel for impact diff, task changes,
// critical path changes, resource overload changes, risk level changes,
// and change request drafting.

export class BaselineView {
  constructor(container, store, deps) {
    this.container = container;
    this.store = store;
    this.baselineManager = deps?.baselineManager;
    this.changeImpactEngine = deps?.changeImpactEngine;
    this.changeRequestBuilder = deps?.changeRequestBuilder;
    this.validationEngine = deps?.validationEngine;
    this.showToast = deps?.showToast || (() => {});
    this.showModal = deps?.showModal || (() => {});

    this._listeners = [];
    this._unsubscribe = null;

    this._buildDOM();
    this._bindEvents();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderToolbar();
    this._renderBaselineList();
    const diff = this.store.state.changeDiff;
    if (diff) {
      this._renderImpactSummary(diff);
      this._renderTaskChangeTable(diff);
      this._renderCriticalPathDiff(diff);
      this._renderResourceOverloadChanges(diff);
      this._renderRiskChanges(diff);
    } else {
      this._renderEmptyState();
    }
    this._renderChangeRequestPanel();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this.container.innerHTML = '';
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── DOM ────────────────────────────────────────────────────────────────

  _buildDOM() {
    this.container.classList.add('baseline-container');
    this.container.innerHTML = `
      <div class="baseline-toolbar" id="bl-toolbar"></div>
      <div class="baseline-body">
        <div class="baseline-sidebar" id="bl-sidebar"></div>
        <div class="baseline-main" id="bl-main"></div>
      </div>
      <div class="cr-panel" id="bl-cr-panel"></div>
    `;
    this._els = {
      toolbar:  this.container.querySelector('#bl-toolbar'),
      sidebar:  this.container.querySelector('#bl-sidebar'),
      main:     this.container.querySelector('#bl-main'),
      crPanel:  this.container.querySelector('#bl-cr-panel'),
    };
  }

  _bindEvents() {
    // Toolbar actions delegated
    this._listen(this._els.toolbar, 'click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'save-baseline') {
        const name = prompt('基线名称:', `Baseline ${new Date().toLocaleDateString('zh-CN')}`);
        if (name) {
          const id = this.baselineManager.saveBaseline(name);
          this.baselineManager.setActiveBaseline(id);
          // Trigger diff computation
          if (this.changeImpactEngine) {
            const diff = this.changeImpactEngine.computeDiff(id);
            if (diff) this.store.state.changeDiff = diff;
          }
          this.showToast('基线已保存', 'success');
        }
      }

      if (action === 'export-baselines') {
        this._exportBaselines();
      }

      if (action === 'import-baselines') {
        this._importBaselines();
      }

      if (action === 'validate') {
        this._runValidation();
      }
    });

    // Sidebar actions (select, delete, rename)
    this._listen(this._els.sidebar, 'click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'activate-baseline') {
        this.baselineManager.setActiveBaseline(id);
        if (this.changeImpactEngine) {
          const diff = this.changeImpactEngine.computeDiff(id);
          if (diff) this.store.state.changeDiff = diff;
        }
      }

      if (action === 'clear-baseline') {
        this.baselineManager.clearActiveBaseline();
        this.store.state.changeDiff = null;
      }

      if (action === 'delete-baseline') {
        if (confirm('确定要删除此基线吗?')) {
          this.baselineManager.deleteBaseline(id);
          this.store.state.changeDiff = null;
        }
      }

      if (action === 'rename-baseline') {
        const bl = this.baselineManager.getBaseline(id);
        const name = prompt('新名称:', bl?.name || '');
        if (name) this.baselineManager.renameBaseline(id, name);
      }
    });

    // CR panel actions
    this._listen(this._els.crPanel, 'click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'create-cr') {
        const title = prompt('变更申请标题:', `CR-${new Date().toISOString().slice(0, 10)}`);
        if (title && this.changeRequestBuilder) {
          const desc = prompt('描述 (可选):', '') || '';
          const crId = this.changeRequestBuilder.createDraft(title, desc);
          if (crId) this.showToast('变更申请已创建', 'success');
          else this.showToast('无法创建变更申请 (无可用差异数据)', 'warning');
        }
      }

      if (action === 'export-cr-json') this._exportCR(id, 'json');
      if (action === 'export-cr-csv') this._exportCR(id, 'csv');
      if (action === 'export-cr-html') this._exportCR(id, 'html');
      if (action === 'export-cr-md') this._exportCR(id, 'md');
      if (action === 'delete-cr') {
        if (this.changeRequestBuilder) {
          this.changeRequestBuilder.deleteDraft(id);
        }
      }
    });
  }

  // ── Toolbar ────────────────────────────────────────────────────────────

  _renderToolbar() {
    const activeId = this.store.state.activeBaselineId;
    const activeBL = activeId ? this.baselineManager?.getBaseline(activeId) : null;
    const activeLabel = activeBL ? `活跃基线: ${this._esc(activeBL.name)}` : '无活跃基线';

    this._els.toolbar.innerHTML = `
      <button class="toolbar-btn" data-action="save-baseline" title="保存当前状态为基线">
        &#x1F4BE; 保存基线
      </button>
      <span class="baseline-active-label">${activeLabel}</span>
      <div style="flex:1"></div>
      <button class="toolbar-btn" data-action="validate" title="验证">
        &#x2705; 验证
      </button>
      <button class="toolbar-btn" data-action="export-baselines" title="导出基线">
        &#x2B06; 导出
      </button>
      <button class="toolbar-btn" data-action="import-baselines" title="导入基线">
        &#x2B07; 导入
      </button>
    `;
  }

  // ── Baseline List ──────────────────────────────────────────────────────

  _renderBaselineList() {
    const baselines = this.baselineManager?.getAllBaselines() || [];
    const activeId = this.store.state.activeBaselineId;

    if (baselines.length === 0) {
      this._els.sidebar.innerHTML = '<p class="baseline-empty">暂无基线。<br/>点击"保存基线"创建。</p>';
      return;
    }

    this._els.sidebar.innerHTML = baselines.map(bl => {
      const isActive = bl.id === activeId;
      const date = new Date(bl.createdAt).toLocaleDateString('zh-CN');
      const taskCount = bl.metrics?.taskCount ?? bl.snapshot?.tasks?.length ?? 0;
      return `
        <div class="baseline-item${isActive ? ' baseline-item--active' : ''}" data-id="${bl.id}">
          <div class="baseline-item-header">
            <strong>${this._esc(bl.name)}</strong>
            ${isActive ? '<span class="baseline-active-dot">●</span>' : ''}
          </div>
          <div class="baseline-item-meta">${date} · ${taskCount} 任务</div>
          <div class="baseline-item-actions">
            ${isActive
              ? `<button class="btn-xs" data-action="clear-baseline" data-id="${bl.id}">取消激活</button>`
              : `<button class="btn-xs" data-action="activate-baseline" data-id="${bl.id}">激活</button>`}
            <button class="btn-xs" data-action="rename-baseline" data-id="${bl.id}">重命名</button>
            <button class="btn-xs btn-xs-danger" data-action="delete-baseline" data-id="${bl.id}">删除</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // ── Empty State ────────────────────────────────────────────────────────

  _renderEmptyState() {
    this._els.main.innerHTML = `
      <div class="baseline-empty-state">
        <p>选择一个基线以查看变更影响分析。</p>
        <p style="color:#64748b;font-size:.85rem;">
          点击"保存基线"捕获当前项目状态，然后激活基线进行比较。
        </p>
      </div>
    `;
  }

  // ── Impact Summary Cards ───────────────────────────────────────────────

  _renderImpactSummary(diff) {
    const s = diff.summary;
    this._els.main.innerHTML = `
      <div class="impact-summary">
        <div class="impact-card">
          <div class="impact-card-value">${s.totalTasksChanged}</div>
          <div class="impact-card-label">变更任务</div>
        </div>
        <div class="impact-card">
          <div class="impact-card-value delay-positive">${s.totalDelayDays}d</div>
          <div class="impact-card-label">总延期天数</div>
        </div>
        <div class="impact-card">
          <div class="impact-card-value">+${s.criticalPathAdded} / -${s.criticalPathRemoved}</div>
          <div class="impact-card-label">关键路径变化</div>
        </div>
        <div class="impact-card">
          <div class="impact-card-value">${s.newOverloads}</div>
          <div class="impact-card-label">新超载</div>
        </div>
        <div class="impact-card">
          <div class="impact-card-value risk-upgraded">${s.risksUpgraded}</div>
          <div class="impact-card-label">风险升级</div>
        </div>
        <div class="impact-card">
          <div class="impact-card-value risk-downgraded">${s.risksDowngraded}</div>
          <div class="impact-card-label">风险降级</div>
        </div>
      </div>
      <div id="bl-task-table"></div>
      <div id="bl-cp-diff"></div>
      <div id="bl-resource-diff"></div>
      <div id="bl-risk-diff"></div>
    `;
  }

  // ── Task Change Table ──────────────────────────────────────────────────

  _renderTaskChangeTable(diff) {
    const container = this._els.main.querySelector('#bl-task-table');
    if (!container) return;

    const changes = (diff.taskChanges || []).filter(
      tc => tc.delayDays !== 0 || tc.isNew || tc.isDeleted || tc.addedToCriticalPath || tc.removedFromCriticalPath
    );

    if (changes.length === 0) {
      container.innerHTML = '<p class="baseline-section-empty">无任务变更</p>';
      return;
    }

    const projMap = new Map(
      (this.store.state.projects ? Array.from(this.store.state.projects.values()) : []).map(p => [p.id, p])
    );

    container.innerHTML = `
      <h3 class="baseline-section-title">任务变更 (${changes.length})</h3>
      <table class="change-table">
        <thead><tr>
          <th>任务</th><th>项目</th><th>延期</th><th>关键路径</th><th>状态</th><th>进度</th>
        </tr></thead>
        <tbody>
          ${changes.map(tc => {
            const proj = projMap.get(tc.projectId);
            const projName = proj ? proj.name : tc.projectId || '';
            const delayClass = tc.delayDays > 0 ? 'delay-positive' : tc.delayDays < 0 ? 'delay-negative' : 'delay-zero';
            const delayText = tc.isNew ? 'NEW' : tc.isDeleted ? 'DELETED' : (tc.delayDays > 0 ? '+' : '') + tc.delayDays + 'd';
            const cpText = tc.addedToCriticalPath ? '<span class="cp-added">+ 新增</span>'
              : tc.removedFromCriticalPath ? '<span class="cp-removed">- 移除</span>'
              : (tc.isCritical ? '● 关键' : '—');
            const statusText = tc.isNew ? '新增' : tc.isDeleted ? '删除' : `${this._esc(tc.baselineStatus)} → ${this._esc(tc.currentStatus)}`;
            const progressText = tc.isNew ? `${tc.currentProgress}%` : tc.isDeleted ? '' : `${tc.baselineProgress}% → ${tc.currentProgress}%`;

            return `<tr>
              <td><strong>${this._esc(tc.taskName)}</strong></td>
              <td>${this._esc(projName)}</td>
              <td class="${delayClass}">${delayText}</td>
              <td>${cpText}</td>
              <td>${statusText}</td>
              <td>${progressText}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // ── Critical Path Diff ─────────────────────────────────────────────────

  _renderCriticalPathDiff(diff) {
    const container = this._els.main.querySelector('#bl-cp-diff');
    if (!container) return;

    const { added, removed } = diff.criticalPathDiff || {};
    if ((!added || added.length === 0) && (!removed || removed.length === 0)) {
      container.innerHTML = '<p class="baseline-section-empty">关键路径无变化</p>';
      return;
    }

    const taskMap = new Map(
      (this.store.state.tasks ? Array.from(this.store.state.tasks.values()) : []).map(t => [t.id, t])
    );
    const getName = (id) => taskMap.get(id)?.name || id;

    let html = '<h3 class="baseline-section-title">关键路径变化</h3><div class="cp-diff-list">';
    for (const id of (added || [])) {
      html += `<div class="cp-diff-item cp-added">+ 新增: <strong>${this._esc(getName(id))}</strong></div>`;
    }
    for (const id of (removed || [])) {
      html += `<div class="cp-diff-item cp-removed">- 移除: <strong>${this._esc(getName(id))}</strong></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // ── Resource Overload Changes ──────────────────────────────────────────

  _renderResourceOverloadChanges(diff) {
    const container = this._els.main.querySelector('#bl-resource-diff');
    if (!container) return;

    const diffs = diff.resourceOverloadDiff || [];
    if (diffs.length === 0) {
      container.innerHTML = '<p class="baseline-section-empty">资源超载无变化</p>';
      return;
    }

    let html = '<h3 class="baseline-section-title">资源超载变化</h3><div class="resource-diff-list">';
    for (const rd of diffs) {
      html += `<div class="resource-diff-item">
        <strong>${this._esc(rd.resourceName)}</strong>
      `;
      if (rd.newOverloads.length > 0) {
        html += '<div class="new-overloads">';
        for (const no of rd.newOverloads) {
          const dateStr = new Date(no.date).toLocaleDateString('zh-CN');
          html += `<div class="overload-new">
            <span class="resource-change-tag">NEW</span> ${dateStr} — 总分配: ${no.totalAllocation}%`;
          if (no.causativeTasks?.length > 0) {
            html += '<div class="overload-causes">';
            for (const ct of no.causativeTasks) {
              html += `<span class="resource-cause-tag">${this._esc(ct.taskName)}${ct.shiftDays ? ` (偏移 ${ct.shiftDays > 0 ? '+' : ''}${ct.shiftDays}d)` : ''}</span>`;
            }
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      if (rd.resolvedOverloads.length > 0) {
        html += `<div class="resolved-overloads">已解决 ${rd.resolvedOverloads.length} 个超载日</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // ── Risk Changes ───────────────────────────────────────────────────────

  _renderRiskChanges(diff) {
    const container = this._els.main.querySelector('#bl-risk-diff');
    if (!container) return;

    const changes = diff.riskChanges || [];
    if (changes.length === 0) {
      container.innerHTML = '<p class="baseline-section-empty">风险等级无变化</p>';
      return;
    }

    container.innerHTML = `
      <h3 class="baseline-section-title">风险等级变化 (${changes.length})</h3>
      <table class="change-table">
        <thead><tr><th>风险</th><th>原等级</th><th>现等级</th><th>方向</th></tr></thead>
        <tbody>
          ${changes.map(rc => {
            const arrow = rc.direction === 'upgraded' ? '▲' : rc.direction === 'downgraded' ? '▼' : '';
            const cls = rc.direction === 'upgraded' ? 'risk-upgraded' : 'risk-downgraded';
            return `<tr>
              <td>${this._esc(rc.name)}</td>
              <td>${this._esc(rc.oldLevel)} (${rc.oldScore})</td>
              <td>${this._esc(rc.newLevel)} (${rc.newScore})</td>
              <td class="${cls}">${arrow} ${rc.direction}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // ── Change Request Panel ───────────────────────────────────────────────

  _renderChangeRequestPanel() {
    const drafts = this.changeRequestBuilder?.getAllDrafts() || [];

    let draftsHTML = '';
    if (drafts.length > 0) {
      draftsHTML = `<div class="cr-draft-list">${drafts.map(d => `
        <div class="cr-draft-item">
          <div class="cr-draft-header">
            <strong>${this._esc(d.title)}</strong>
            <span class="cr-draft-status cr-status-${d.status}">${d.status}</span>
          </div>
          <div class="cr-draft-meta">${new Date(d.createdAt).toLocaleDateString('zh-CN')} · ${d.summary?.totalTasksChanged || 0} tasks</div>
          <div class="cr-draft-actions">
            <button class="btn-xs" data-action="export-cr-json" data-id="${d.id}">JSON</button>
            <button class="btn-xs" data-action="export-cr-csv" data-id="${d.id}">CSV</button>
            <button class="btn-xs" data-action="export-cr-html" data-id="${d.id}">HTML</button>
            <button class="btn-xs" data-action="export-cr-md" data-id="${d.id}">MD</button>
            <button class="btn-xs btn-xs-danger" data-action="delete-cr" data-id="${d.id}">删除</button>
          </div>
        </div>
      `).join('')}</div>`;
    }

    this._els.crPanel.innerHTML = `
      <div class="cr-panel-header">
        <strong>变更申请</strong>
        <button class="btn-xs" data-action="create-cr">创建草案</button>
      </div>
      ${draftsHTML || '<p class="cr-empty">暂无变更申请草案</p>'}
    `;
  }

  // ── Export / Import Helpers ────────────────────────────────────────────

  _exportBaselines() {
    const json = this.baselineManager?.exportBaselines();
    if (!json) { this.showToast('无基线可导出', 'warning'); return; }
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `baselines-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('基线已导出', 'success');
  }

  _importBaselines() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = this.baselineManager?.importBaselines(reader.result);
        if (result) {
          this.showToast(`已导入 ${result.imported} 个基线`, 'success');
          if (result.errors.length > 0) {
            for (const err of result.errors) this.showToast(err, 'warning', 5000);
          }
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  _runValidation() {
    if (!this.validationEngine) { this.showToast('验证引擎不可用', 'warning'); return; }
    const issues = this.validationEngine.validateAll();

    // Also validate active baseline
    const activeId = this.store.state.activeBaselineId;
    if (activeId) {
      issues.push(...this.validationEngine.validateBaselineIntegrity(activeId));
    }

    if (issues.length === 0) {
      this.showToast('验证通过 — 无问题', 'success');
      return;
    }

    const icon = { error: '🔴', warning: '🟡', info: '🔵' };
    const html = `
      <h2 style="margin-top:0">验证结果 (${issues.length} 个问题)</h2>
      <div style="max-height:400px;overflow-y:auto">
        ${issues.map(i => `
          <div style="padding:0.5rem;margin:0.25rem 0;border-left:3px solid ${i.severity === 'error' ? '#ef4444' : i.severity === 'warning' ? '#eab308' : '#3b82f6'};background:#1e293b;border-radius:0 4px 4px 0">
            ${icon[i.severity] || '🔵'} <strong>${this._esc(i.type)}</strong>: ${this._esc(i.message)}
          </div>
        `).join('')}
      </div>
      <button class="modal-close" style="margin-top:1rem">关闭</button>
    `;
    this.showModal(html);
  }

  _exportCR(id, format) {
    if (!this.changeRequestBuilder) return;
    let content, filename, mimeType;

    switch (format) {
      case 'json':
        content = this.changeRequestBuilder.exportAsJSON(id);
        filename = `change-request-${id.slice(0, 8)}.json`;
        mimeType = 'application/json';
        break;
      case 'csv':
        content = this.changeRequestBuilder.exportAsCSV(id);
        filename = `change-request-${id.slice(0, 8)}.csv`;
        mimeType = 'text/csv';
        break;
      case 'html':
        content = this.changeRequestBuilder.exportAsHTML(id);
        filename = `change-request-${id.slice(0, 8)}.html`;
        mimeType = 'text/html';
        break;
      case 'md':
        content = this.changeRequestBuilder.exportAsMarkdown(id);
        filename = `change-request-${id.slice(0, 8)}.md`;
        mimeType = 'text/markdown';
        break;
      default:
        return;
    }

    if (!content) { this.showToast('导出失败', 'error'); return; }

    if (format === 'html') {
      const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      URL.revokeObjectURL(url);
    } else {
      const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    this.showToast('已导出', 'success');
  }
}
