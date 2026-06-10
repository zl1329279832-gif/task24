/* ============================================================
   app.js  –  Main application controller
   ============================================================ */
const App = (() => {
    let currentView = 'gantt';
    let currentFilters = {};

    function init() {
        // Init all modules
        GanttChart.init();
        MilestoneView.init();
        HeatmapView.init();
        ResourceView.init();
        RiskMatrixView.init();

        // View tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                _switchView(currentView);
            });
        });

        // Toolbar buttons
        document.getElementById('btn-import').addEventListener('click', _showImportModal);
        document.getElementById('btn-save').addEventListener('click', _showSaveModal);
        document.getElementById('btn-load').addEventListener('click', _showLoadModal);
        document.getElementById('btn-export').addEventListener('click', () => ExportManager.exportReport());
        document.getElementById('btn-undo').addEventListener('click', () => { History.undo(); _refreshAll(); });
        document.getElementById('btn-redo').addEventListener('click', () => { History.redo(); _refreshAll(); });

        // Import modal
        document.getElementById('btn-do-import').addEventListener('click', _doImport);
        document.getElementById('btn-load-sample').addEventListener('click', _loadSampleData);

        // Save modal
        document.getElementById('btn-do-save').addEventListener('click', _doSave);

        // Modal close
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', e => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        });

        // Filter changes
        ['filter-dept', 'filter-pm', 'filter-status', 'filter-risk', 'filter-project'].forEach(id => {
            document.getElementById(id).addEventListener('change', _onFilterChange);
        });
        document.getElementById('btn-clear-filters').addEventListener('click', _clearFilters);

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); History.undo(); _refreshAll(); }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); History.redo(); _refreshAll(); }
        });

        // History state change
        History.on(() => {
            document.getElementById('btn-undo').disabled = !History.canUndo();
            document.getElementById('btn-redo').disabled = !History.canRedo();
        });

        // Data model changes
        DataModel.on(type => {
            if (type === 'restore') {
                _updateFilterOptions();
                _renderCurrentView();
            }
        });

        // File input handlers
        _setupFileInput('file-tasks', 'text-tasks');
        _setupFileInput('file-risks', 'text-risks');
        _setupFileInput('file-resources', 'text-resources');
    }

    function _setupFileInput(fileId, textId) {
        document.getElementById(fileId).addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                document.getElementById(textId).value = ev.target.result;
            };
            reader.readAsText(file, 'UTF-8');
        });
    }

    function _switchView(view) {
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-' + view).classList.add('active');
        _renderCurrentView();
    }

    function _renderCurrentView() {
        switch (currentView) {
            case 'gantt': GanttChart.render(currentFilters); break;
            case 'milestone': MilestoneView.render(currentFilters); break;
            case 'heatmap': HeatmapView.render(currentFilters); break;
            case 'resource': ResourceView.render(currentFilters); break;
            case 'risk': RiskMatrixView.render(currentFilters); break;
        }
    }

    function _refreshAll() {
        _updateFilterOptions();
        _renderCurrentView();
    }

    function _onFilterChange() {
        currentFilters = {};
        const dept = document.getElementById('filter-dept').value;
        const pm = document.getElementById('filter-pm').value;
        const status = document.getElementById('filter-status').value;
        const risk = document.getElementById('filter-risk').value;
        const project = document.getElementById('filter-project').value;
        if (dept) currentFilters.department = dept;
        if (pm) currentFilters.pm = pm;
        if (status) currentFilters.status = status;
        if (risk) currentFilters.riskLevel = risk;
        if (project) currentFilters.project = project;
        _renderCurrentView();
    }

    function _clearFilters() {
        document.getElementById('filter-dept').value = '';
        document.getElementById('filter-pm').value = '';
        document.getElementById('filter-status').value = '';
        document.getElementById('filter-risk').value = '';
        document.getElementById('filter-project').value = '';
        currentFilters = {};
        _renderCurrentView();
    }

    function _updateFilterOptions() {
        const depts = DataModel.getDepartments();
        const pms = DataModel.getAssignees();
        const projects = DataModel.getProjectList();

        _updateSelect('filter-dept', depts.map(d => ({ value: d, label: d })));
        _updateSelect('filter-pm', pms.map(p => ({ value: p, label: p })));
        _updateSelect('filter-project', projects.map(p => ({ value: p.id, label: p.name })));
    }

    function _updateSelect(id, options) {
        const sel = document.getElementById(id);
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">全部</option>';
        options.forEach(o => {
            sel.innerHTML += `<option value="${o.value}">${o.label}</option>`;
        });
        sel.value = currentVal;
    }

    // --- Import ---
    function _showImportModal() {
        document.getElementById('modal-import').classList.remove('hidden');
        document.getElementById('import-errors').classList.add('hidden');
    }

    function _doImport() {
        const merge = document.getElementById('import-merge').checked;
        const validate = document.getElementById('import-validate').checked;
        const allErrors = [];

        const tasksText = document.getElementById('text-tasks').value;
        const risksText = document.getElementById('text-risks').value;
        const resourcesText = document.getElementById('text-resources').value;

        if (!tasksText && !risksText && !resourcesText) {
            Utils.showToast('请输入或选择至少一个CSV文件', 'warning');
            return;
        }

        History.pushState('导入数据');

        if (tasksText) {
            const result = CSVParser.parseTasks(tasksText);
            allErrors.push(...result.errors);
            if (result.tasks.length > 0) {
                DataModel.importTasks(result.tasks, merge);
                Utils.showToast(`成功导入 ${result.tasks.length} 个任务`, 'success');
            }
        }

        if (risksText) {
            const result = CSVParser.parseRisks(risksText);
            allErrors.push(...result.errors);
            if (result.risks.length > 0) {
                DataModel.importRisks(result.risks, merge);
                Utils.showToast(`成功导入 ${result.risks.length} 个风险项`, 'success');
            }
        }

        if (resourcesText) {
            const result = CSVParser.parseResources(resourcesText);
            allErrors.push(...result.errors);
            if (result.resources.length > 0) {
                DataModel.importResources(result.resources, merge);
                Utils.showToast(`成功导入 ${result.resources.length} 条资源数据`, 'success');
            }
        }

        // Run scheduler
        const cpmResult = Scheduler.calculateCPM(DataModel.getTasks());
        if (cpmResult.brokenEdges.length > 0) {
            allErrors.push(`检测到循环依赖，已自动断开 ${cpmResult.brokenEdges.length} 条依赖关系`);
            cpmResult.brokenEdges.forEach(e => {
                allErrors.push(`  断开: ${e.from} → ${e.to}`);
            });
        }

        // Show errors/warnings
        if (allErrors.length > 0 && validate) {
            const errDiv = document.getElementById('import-errors');
            errDiv.classList.remove('hidden');
            errDiv.innerHTML = '<strong>导入警告:</strong><br>' + allErrors.map(e => `• ${e}`).join('<br>');
        }

        _updateFilterOptions();
        _renderCurrentView();

        if (allErrors.length === 0) {
            document.getElementById('modal-import').classList.add('hidden');
        }
    }

    // --- Save/Load ---
    function _showSaveModal() {
        document.getElementById('save-modal-title').textContent = '保存方案';
        document.getElementById('save-form').style.display = 'block';
        document.getElementById('load-list').classList.add('hidden');
        document.getElementById('modal-save').classList.remove('hidden');
        document.getElementById('save-name').value = `方案_${Utils.formatDate(Utils.today())}`;
    }

    function _showLoadModal() {
        document.getElementById('save-modal-title').textContent = '加载方案';
        document.getElementById('save-form').style.display = 'none';
        const loadList = document.getElementById('load-list');
        loadList.classList.remove('hidden');

        const saves = _getSaves();
        if (saves.length === 0) {
            loadList.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8">暂无保存的方案</div>';
        } else {
            loadList.innerHTML = saves.map((s, i) => `
                <div class="load-item" data-idx="${i}">
                    <div>
                        <div class="load-item-name">${s.name}</div>
                        <div class="load-item-date">${s.date}</div>
                    </div>
                    <div class="load-item-actions">
                        <button class="btn btn-primary" onclick="App.loadScenario(${i})">加载</button>
                        <button class="btn btn-danger" onclick="App.deleteScenario(${i})">删除</button>
                    </div>
                </div>
            `).join('');
        }

        document.getElementById('modal-save').classList.remove('hidden');
    }

    function _doSave() {
        const name = document.getElementById('save-name').value.trim();
        if (!name) { Utils.showToast('请输入方案名称', 'warning'); return; }

        const saves = _getSaves();
        saves.push({
            name,
            date: new Date().toLocaleString('zh-CN'),
            data: DataModel.getSnapshot()
        });

        try {
            localStorage.setItem('pmo_saves', JSON.stringify(saves));
            Utils.showToast(`方案"${name}"已保存`, 'success');
            document.getElementById('modal-save').classList.add('hidden');
        } catch (e) {
            Utils.showToast('保存失败：存储空间不足', 'error');
        }
    }

    function loadScenario(idx) {
        const saves = _getSaves();
        if (!saves[idx]) return;

        History.pushState('加载方案');
        DataModel.restoreSnapshot(saves[idx].data);
        Scheduler.calculateCPM(DataModel.getTasks());
        _updateFilterOptions();
        _renderCurrentView();
        document.getElementById('modal-save').classList.add('hidden');
        Utils.showToast(`已加载方案"${saves[idx].name}"`, 'success');
    }

    function deleteScenario(idx) {
        const saves = _getSaves();
        saves.splice(idx, 1);
        localStorage.setItem('pmo_saves', JSON.stringify(saves));
        _showLoadModal();
        Utils.showToast('方案已删除', 'info');
    }

    function _getSaves() {
        try {
            return JSON.parse(localStorage.getItem('pmo_saves') || '[]');
        } catch { return []; }
    }

    // --- Sample Data ---
    function _loadSampleData() {
        const tasksCSV = `项目ID,项目名,任务ID,任务名,负责人,部门,计划开始,计划结束,实际开始,实际结束,状态,前置任务,里程碑,人力投入
P001,电商平台重构,T001,需求分析,张伟,产品部,2026-05-01,2026-05-15,2026-05-01,2026-05-14,已完成,,N,100
P001,电商平台重构,T002,架构设计,李明,技术部,2026-05-16,2026-05-30,2026-05-16,,进行中,T001,N,100
P001,电商平台重构,T003,数据库设计,王芳,技术部,2026-05-20,2026-06-05,2026-05-22,,进行中,T001,N,80
P001,电商平台重构,T004,前端开发,赵强,前端部,2026-06-01,2026-07-15,,,未开始,T002;T003,N,100
P001,电商平台重构,T005,后端开发,李明,技术部,2026-06-01,2026-07-20,,,未开始,T002;T003,N,100
P001,电商平台重构,T006,接口联调,赵强,前端部,2026-07-16,2026-07-30,,,未开始,T004;T005,N,60
P001,电商平台重构,T007,系统测试,周丽,测试部,2026-08-01,2026-08-20,,,未开始,T006,N,100
P001,电商平台重构,M001,一期上线,张伟,产品部,2026-08-25,2026-08-25,,,未开始,T007,Y,0
P002,移动App升级,T010,UI改版设计,陈思,设计部,2026-05-10,2026-05-25,2026-05-10,2026-05-28,已完成,,N,100
P002,移动App升级,T011,iOS开发,刘洋,移动端,2026-05-26,2026-06-30,2026-05-29,,进行中,T010,N,100
P002,移动App升级,T012,Android开发,王芳,移动端,2026-05-26,2026-06-30,2026-05-29,,进行中,T010,N,100
P002,移动App升级,T013,后端API适配,李明,技术部,2026-06-01,2026-06-20,2026-06-03,,进行中,T010,N,50
P002,移动App升级,T014,集成测试,周丽,测试部,2026-07-01,2026-07-15,,,未开始,T011;T012;T013,N,100
P002,移动App升级,M002,App发布,陈思,设计部,2026-07-20,2026-07-20,,,未开始,T014,Y,0
P003,数据中台建设,T020,数据源梳理,赵强,数据部,2026-04-15,2026-05-10,2026-04-15,2026-05-18,已延期,,N,100
P003,数据中台建设,T021,ETL管道开发,刘洋,数据部,2026-05-11,2026-06-15,2026-05-20,,延期,T020,N,100
P003,数据中台建设,T022,数据仓库搭建,赵强,数据部,2026-05-20,2026-06-20,2026-05-25,,进行中,T020,N,80
P003,数据中台建设,T023,BI看板开发,陈思,数据部,2026-06-16,2026-07-15,,,未开始,T021;T022,N,100
P003,数据中台建设,T024,数据质量监控,周丽,测试部,2026-06-20,2026-07-10,,,未开始,T021,N,60
P003,数据中台建设,M003,中台上线,赵强,数据部,2026-07-20,2026-07-20,,,未开始,T023;T024,Y,0
P004,安全合规升级,T030,安全审计,张伟,安全部,2026-05-01,2026-05-20,2026-05-01,2026-05-22,已完成,,N,100
P004,安全合规升级,T031,漏洞修复,李明,技术部,2026-05-21,2026-06-10,2026-05-23,,延期,T030,N,80
P004,安全合规升级,T032,权限重构,刘洋,技术部,2026-05-25,2026-06-15,2026-05-28,,进行中,T030,N,100
P004,安全合规升级,T033,渗透测试,周丽,安全部,2026-06-11,2026-06-25,,,未开始,T031;T032,N,100
P004,安全合规升级,T034,合规认证准备,张伟,安全部,2026-06-26,2026-07-15,,,未开始,T033,N,50
P004,安全合规升级,M004,通过合规认证,张伟,安全部,2026-07-20,2026-07-20,,,未开始,T034,Y,0`;

        const risksCSV = `风险ID,项目ID,描述,概率,影响,责任人,缓解措施,状态
R001,P001,第三方支付接口变更导致集成延迟,4,4,李明,提前与支付方沟通接口变更计划;准备备用方案,open
R002,P001,前端性能不达标影响上线,3,4,赵强,提前进行性能基准测试;引入性能监控,open
R003,P002,iOS审核被拒导致发布延迟,3,5,刘洋,提前准备审核材料;预留缓冲时间,open
R004,P002,Android碎片化兼容问题,4,3,王芳,扩大测试设备覆盖;使用兼容层框架,open
R005,P003,数据源质量差影响ETL稳定性,5,4,赵强,建立数据质量基线;增加数据清洗环节,open
R006,P003,大数据量处理性能瓶颈,4,3,刘洋,分阶段上线;预留扩容方案,open
R007,P004,合规要求变更导致返工,3,5,张伟,密切跟踪最新法规;与合规团队保持沟通,open
R008,P004,安全漏洞修复影响业务功能,2,4,李明,灰度发布;建立回滚方案,open
R009,P001,核心技术人员离职风险,2,5,张伟,知识转移文档化;培养备份人员,open
R010,P003,BI工具选型不当导致返工,3,3,陈思,先做POC验证;评估多种工具,open`;

        const resourcesCSV = `人员,部门,项目ID,任务ID,投入百分比,开始日期,结束日期
李明,技术部,P001,T002,100,2026-05-16,2026-05-30
李明,技术部,P002,T013,50,2026-06-01,2026-06-20
李明,技术部,P001,T005,100,2026-06-01,2026-07-20
李明,技术部,P004,T031,80,2026-05-23,2026-06-10
王芳,技术部,P001,T003,80,2026-05-22,2026-06-05
王芳,移动端,P002,T012,100,2026-05-29,2026-06-30
赵强,前端部,P001,T004,100,2026-06-01,2026-07-15
赵强,数据部,P003,T022,80,2026-05-25,2026-06-20
周丽,测试部,P001,T007,100,2026-08-01,2026-08-20
周丽,测试部,P002,T014,100,2026-07-01,2026-07-15
周丽,测试部,P003,T024,60,2026-06-20,2026-07-10
周丽,安全部,P004,T033,100,2026-06-11,2026-06-25
刘洋,移动端,P002,T011,100,2026-05-29,2026-06-30
刘洋,数据部,P003,T021,100,2026-05-20,2026-06-15
刘洋,技术部,P004,T032,100,2026-05-28,2026-06-15`;

        document.getElementById('text-tasks').value = tasksCSV;
        document.getElementById('text-risks').value = risksCSV;
        document.getElementById('text-resources').value = resourcesCSV;
        Utils.showToast('示例数据已加载到输入框，点击"导入"确认', 'info');
    }

    function getFilters() { return currentFilters; }

    return { init, get currentFilters() { return currentFilters; }, loadScenario, deleteScenario, getFilters };
})();

// Boot
document.addEventListener('DOMContentLoaded', App.init);
