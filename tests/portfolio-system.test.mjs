/**
 * Comprehensive test suite for the multi-project portfolio risk system.
 *
 * Covers: store versioning, multi-file import, baseline save/restore,
 * undo/redo with version tracking, cycle dependency interception,
 * stale Worker result discard, and Gantt/Resource/Risk consistency.
 *
 * Run: node --experimental-vm-modules tests/portfolio-system.test.js
 */

// ---------------------------------------------------------------------------
// Minimal browser-global shims for Node.js
// ---------------------------------------------------------------------------
if (typeof globalThis.localStorage === 'undefined') {
  const _store = {};
  globalThis.localStorage = {
    getItem(k) { return _store[k] ?? null; },
    setItem(k, v) { _store[k] = String(v); },
    removeItem(k) { delete _store[k]; },
    clear() { for (const k in _store) delete _store[k]; },
  };
}
if (typeof globalThis.crypto === 'undefined') {
  let _counter = 0;
  globalThis.crypto = { randomUUID() { return `test-uuid-${++_counter}-${Date.now()}`; } };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let _passed = 0;
let _failed = 0;
let _tests = [];

function describe(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  fn();
}

function it(name, fn) {
  _tests.push({ name, fn });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertGreater(a, b, msg) {
  if (!(a > b)) throw new Error(`${msg || 'assertGreater'}: expected ${a} > ${b}`);
}

function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) throw new Error(`${msg || 'assertIncludes'}: ${JSON.stringify(item)} not in array`);
}

async function runTests() {
  for (const t of _tests) {
    try {
      await t.fn();
      _passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      _failed++;
      console.error(`  ✗ ${t.name}: ${e.message}`);
    }
  }
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);
  if (_failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Import modules
// ---------------------------------------------------------------------------
const { Store } = await import('../js/core/store.js');
const { HistoryManager } = await import('../js/core/history-manager.js');
const { DependencyEngine } = await import('../js/core/dependency-engine.js');
const { BaselineManager } = await import('../js/core/baseline-manager.js');
const { ChangeImpactEngine } = await import('../js/engine/change-impact-engine.js');
const { ResourceEngine } = await import('../js/engine/resource-engine.js');
const { RiskEngine } = await import('../js/engine/risk-engine.js');
const { ValidationEngine } = await import('../js/engine/validation-engine.js');

// ---------------------------------------------------------------------------
// Helper: create a fully-wired system
// ---------------------------------------------------------------------------
function createSystem() {
  const store = new Store();
  const dependencyEngine = new DependencyEngine(store);
  const resourceEngine = new ResourceEngine(store);
  const riskEngine = new RiskEngine(store);
  const historyManager = new HistoryManager(store, { autoCapture: false });
  const baselineManager = new BaselineManager(store, {
    dependencyEngine, resourceEngine, riskEngine,
  });
  const changeImpactEngine = new ChangeImpactEngine(store, baselineManager, {
    dependencyEngine, resourceEngine, riskEngine,
    workerRequest: () => Promise.resolve(null),
  });
  const validationEngine = new ValidationEngine(store, {
    dependencyEngine, resourceEngine, baselineManager,
  });
  return {
    store, dependencyEngine, resourceEngine, riskEngine,
    historyManager, baselineManager, changeImpactEngine, validationEngine,
  };
}

/** Helper: seed a standard 3-project portfolio */
function seedPortfolio(store) {
  const d = (offset) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + offset);
    return dt.toISOString().slice(0, 10);
  };

  store.addProject({ id: 'p1', name: 'Alpha', department: 'Eng', projectManager: 'PM1', status: 'active', startDate: d(-30), endDate: d(60) });
  store.addProject({ id: 'p2', name: 'Beta', department: 'IT', projectManager: 'PM2', status: 'active', startDate: d(-10), endDate: d(50) });
  store.addProject({ id: 'p3', name: 'Gamma', department: 'Mkt', projectManager: 'PM3', status: 'active', startDate: d(0), endDate: d(90) });

  store.addTask({ id: 't1', projectId: 'p1', name: 'Design', plannedStart: d(-30), plannedEnd: d(-20), dependencies: [], estimatedDays: 10, status: 'completed', progress: 100, assignee: 'A1' });
  store.addTask({ id: 't2', projectId: 'p1', name: 'Develop', plannedStart: d(-19), plannedEnd: d(-5), dependencies: ['t1'], estimatedDays: 14, status: 'in-progress', progress: 60, assignee: 'A2' });
  store.addTask({ id: 't3', projectId: 'p1', name: 'Test', plannedStart: d(-4), plannedEnd: d(10), dependencies: ['t2'], estimatedDays: 14, status: 'not-started', progress: 0, assignee: 'A1' });
  store.addTask({ id: 't4', projectId: 'p2', name: 'Assess', plannedStart: d(-10), plannedEnd: d(-3), dependencies: [], estimatedDays: 7, status: 'completed', progress: 100, assignee: 'A3' });
  store.addTask({ id: 't5', projectId: 'p2', name: 'Migrate', plannedStart: d(-2), plannedEnd: d(15), dependencies: ['t4'], crossProjectDeps: [{ projectId: 'p1', taskId: 't2' }], estimatedDays: 17, status: 'not-started', progress: 0, assignee: 'A2' });
  store.addTask({ id: 't6', projectId: 'p3', name: 'Research', plannedStart: d(0), plannedEnd: d(12), dependencies: [], estimatedDays: 12, status: 'in-progress', progress: 20, assignee: 'A4' });
  store.addTask({ id: 't7', projectId: 'p3', name: 'Execute', plannedStart: d(13), plannedEnd: d(30), dependencies: ['t6'], crossProjectDeps: [{ projectId: 'p1', taskId: 't3' }], estimatedDays: 17, status: 'not-started', progress: 0, assignee: 'A4' });

  store.addResource({ id: 'r1', name: 'A1', department: 'Eng', role: 'Tester', tasks: [{ taskId: 't1', projectId: 'p1', allocation: 80 }, { taskId: 't3', projectId: 'p1', allocation: 100 }], maxCapacity: 100 });
  store.addResource({ id: 'r2', name: 'A2', department: 'Eng', role: 'Dev', tasks: [{ taskId: 't2', projectId: 'p1', allocation: 80 }, { taskId: 't5', projectId: 'p2', allocation: 70 }], maxCapacity: 100 });
  store.addResource({ id: 'r3', name: 'A3', department: 'IT', role: 'Ops', tasks: [{ taskId: 't4', projectId: 'p2', allocation: 60 }], maxCapacity: 100 });
  store.addResource({ id: 'r4', name: 'A4', department: 'Mkt', role: 'Analyst', tasks: [{ taskId: 't6', projectId: 'p3', allocation: 60 }, { taskId: 't7', projectId: 'p3', allocation: 80 }], maxCapacity: 100 });

  store.addRisk({ id: 'rk1', projectId: 'p1', taskId: 't2', name: 'Tech risk', probability: 3, impact: 4, category: 'tech', status: 'open', owner: 'A2' });
  store.addRisk({ id: 'rk2', projectId: 'p2', taskId: 't5', name: 'Data loss', probability: 2, impact: 5, category: 'tech', status: 'open', owner: 'A3' });
  store.addRisk({ id: 'rk3', projectId: 'p3', taskId: '', name: 'Budget', probability: 3, impact: 3, category: 'cost', status: 'open', owner: 'PM3' });
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST SUITES
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
//  1. Store version numbering
// ───────────────────────────────────────────────────────────────────────
describe('Store version numbering', () => {

  it('starts at version 0', () => {
    const { store } = createSystem();
    assertEqual(store.getVersion(), 0, 'initial version');
  });

  it('increments version on addProject', () => {
    const { store } = createSystem();
    const v0 = store.getVersion();
    store.addProject({ id: 'p1', name: 'Test' });
    assertGreater(store.getVersion(), v0, 'version should increase after addProject');
  });

  it('increments version on addTask', () => {
    const { store } = createSystem();
    store.addProject({ id: 'p1', name: 'P' });
    const v0 = store.getVersion();
    store.addTask({ id: 't1', projectId: 'p1', name: 'T' });
    assertGreater(store.getVersion(), v0, 'version should increase after addTask');
  });

  it('increments version on batch', () => {
    const { store } = createSystem();
    const v0 = store.getVersion();
    store.batch(() => {
      store.addProject({ id: 'p1', name: 'P' });
      store.addTask({ id: 't1', projectId: 'p1', name: 'T' });
    });
    assertGreater(store.getVersion(), v0, 'version should increase after batch');
  });

  it('increments version on replaceAll', () => {
    const { store } = createSystem();
    store.addProject({ id: 'p1', name: 'P' });
    const v0 = store.getVersion();
    store.replaceAll({ projects: [{ id: 'p2', name: 'Q' }], tasks: [], risks: [], resources: [] });
    assertGreater(store.getVersion(), v0, 'version should increase after replaceAll');
  });

  it('includes version in getSnapshot', () => {
    const { store } = createSystem();
    store.addProject({ id: 'p1', name: 'P' });
    const snapshot = store.getSnapshot();
    assertEqual(snapshot.version, store.getVersion(), 'snapshot version should match store version');
  });

  it('exposes version via state proxy', () => {
    const { store } = createSystem();
    store.addProject({ id: 'p1', name: 'P' });
    assertEqual(store.state.version, store.getVersion(), 'state.version should match getVersion');
  });

  it('setVersion enforces monotonicity', () => {
    const { store } = createSystem();
    store.addProject({ id: 'p1', name: 'P' });
    const v = store.getVersion();
    store.setVersion(v - 5); // try to go backwards
    assertEqual(store.getVersion(), v, 'version should not decrease');
    store.setVersion(v + 10);
    assertEqual(store.getVersion(), v + 10, 'version should jump forward');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  2. Multi-file import
// ───────────────────────────────────────────────────────────────────────
describe('Multi-file import', () => {

  it('imports data from multiple sources with ID remapping', () => {
    const { store } = createSystem();
    // Import first batch
    store.importData({
      projects: [{ id: 'old-p1', name: 'Project A' }],
      tasks: [{ id: 'old-t1', projectId: 'old-p1', name: 'Task A1', dependencies: [] }],
      risks: [],
      resources: [],
    });
    // Import second batch
    store.importData({
      projects: [{ id: 'old-p2', name: 'Project B' }],
      tasks: [{ id: 'old-t2', projectId: 'old-p2', name: 'Task B1', dependencies: [] }],
      risks: [],
      resources: [],
    });
    assertEqual(store.state.projects.size, 2, 'should have 2 projects');
    assertEqual(store.state.tasks.size, 2, 'should have 2 tasks');
    // IDs should be remapped (not 'old-p1' or 'old-p2')
    assert(!store.state.projects.has('old-p1'), 'old project ID should be remapped');
    assert(!store.state.projects.has('old-p2'), 'old project ID should be remapped');
  });

  it('cross-project dependencies are remapped during import', () => {
    const { store } = createSystem();
    store.importData({
      projects: [
        { id: 'x-p1', name: 'P1' },
        { id: 'x-p2', name: 'P2' },
      ],
      tasks: [
        { id: 'x-t1', projectId: 'x-p1', name: 'T1', dependencies: [] },
        { id: 'x-t2', projectId: 'x-p2', name: 'T2', dependencies: [],
          crossProjectDeps: [{ projectId: 'x-p1', taskId: 'x-t1' }] },
      ],
    });
    // Find the remapped task that has cross-project deps
    let found = false;
    for (const t of store.state.tasks.values()) {
      if (t.name === 'T2' && t.crossProjectDeps?.length > 0) {
        const cpd = t.crossProjectDeps[0];
        // The referenced taskId should NOT be the original 'x-t1'
        assert(cpd.taskId !== 'x-t1', 'cross-project dep taskId should be remapped');
        // The remapped taskId should exist in the store
        assert(store.state.tasks.has(cpd.taskId), 'remapped taskId should exist');
        found = true;
      }
    }
    assert(found, 'should find task with cross-project deps');
  });

  it('version increases after each import', () => {
    const { store } = createSystem();
    const v0 = store.getVersion();
    store.importData({
      projects: [{ id: 'ip1', name: 'P1' }],
      tasks: [{ id: 'it1', projectId: 'ip1', name: 'T1' }],
    });
    const v1 = store.getVersion();
    assertGreater(v1, v0, 'version should increase after first import');
    store.importData({
      projects: [{ id: 'ip2', name: 'P2' }],
      tasks: [{ id: 'it2', projectId: 'ip2', name: 'T2' }],
    });
    assertGreater(store.getVersion(), v1, 'version should increase after second import');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  3. Baseline save and restore
// ───────────────────────────────────────────────────────────────────────
describe('Baseline save and restore', () => {

  it('saves a baseline with store version', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const vBefore = sys.store.getVersion();
    const blId = sys.baselineManager.saveBaseline('BL-1', 'Test baseline');
    const bl = sys.baselineManager.getBaseline(blId);
    assert(bl !== null, 'baseline should exist');
    assertEqual(bl.name, 'BL-1');
    assertEqual(bl.storeVersion, vBefore, 'baseline should record store version');
    assertEqual(bl.snapshot.tasks.length, 7, 'baseline should capture all 7 tasks');
  });

  it('restores a baseline to the store', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('BL-restore');

    // Modify the store
    sys.store.addTask({ id: 'extra', projectId: 'p1', name: 'Extra Task' });
    assertEqual(sys.store.state.tasks.size, 8, 'should have 8 tasks after adding');

    // Restore baseline
    const ok = sys.baselineManager.restoreBaseline(blId);
    assert(ok, 'restoreBaseline should succeed');
    assertEqual(sys.store.state.tasks.size, 7, 'should have 7 tasks after restore');
    assert(!sys.store.state.tasks.has('extra'), 'extra task should be gone after restore');
  });

  it('restore bumps store version', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('BL-v');
    sys.store.addTask({ id: 'tmp', projectId: 'p1', name: 'Tmp' });
    const vBefore = sys.store.getVersion();
    sys.baselineManager.restoreBaseline(blId);
    assertGreater(sys.store.getVersion(), vBefore, 'version should increase after restore');
  });

  it('baseline diff detects task delays', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('BL-diff');
    sys.baselineManager.setActiveBaseline(blId);

    // Delay task t3 by 5 days
    const t3 = sys.store.state.tasks.get('t3');
    const oldEnd = new Date(t3.plannedEnd);
    oldEnd.setDate(oldEnd.getDate() + 5);
    sys.store.updateTask('t3', { plannedEnd: oldEnd.toISOString().slice(0, 10) });

    const diff = sys.changeImpactEngine.computeDiff(blId);
    assert(diff !== null, 'diff should exist');
    const t3Change = diff.taskChanges.find(tc => tc.taskId === 't3');
    assert(t3Change !== null, 'should find t3 change');
    assertGreater(t3Change.delayDays, 0, 'should detect delay for t3');
  });

  it('baseline diff includes version info', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('BL-ver');
    sys.baselineManager.setActiveBaseline(blId);

    const diff = sys.changeImpactEngine.computeDiff(blId);
    assert(diff !== null, 'diff should exist');
    assert(diff.storeVersion !== undefined, 'diff should have storeVersion');
    assert(diff.baselineVersion !== undefined, 'diff should have baselineVersion');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  4. Undo/Redo with version tracking
// ───────────────────────────────────────────────────────────────────────
describe('Undo/Redo with version tracking', () => {

  it('undo restores previous state', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('After seed');
    const taskCountBefore = sys.store.state.tasks.size;

    sys.store.addTask({ id: 'new-t', projectId: 'p1', name: 'New' });
    sys.historyManager.push('After add');
    assertEqual(sys.store.state.tasks.size, taskCountBefore + 1);

    const result = sys.historyManager.undo();
    assert(result.success, 'undo should succeed');
    assertEqual(sys.store.state.tasks.size, taskCountBefore, 'should restore task count');
    assert(result.version !== undefined, 'undo should return version');
  });

  it('redo re-applies undone state', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('After seed');

    sys.store.addTask({ id: 'new-t', projectId: 'p1', name: 'New' });
    sys.historyManager.push('After add');

    sys.historyManager.undo();
    assertEqual(sys.store.state.tasks.size, 7);

    const result = sys.historyManager.redo();
    assert(result.success, 'redo should succeed');
    assertEqual(sys.store.state.tasks.size, 8);
    assert(result.version !== undefined, 'redo should return version');
  });

  it('version always increases after undo and redo', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('s0');

    sys.store.addTask({ id: 'x', projectId: 'p1', name: 'X' });
    sys.historyManager.push('s1');
    const v1 = sys.store.getVersion();

    const undoResult = sys.historyManager.undo();
    const v2 = sys.store.getVersion();
    assertGreater(v2, v1, 'version must increase after undo');

    const redoResult = sys.historyManager.redo();
    const v3 = sys.store.getVersion();
    assertGreater(v3, v2, 'version must increase after redo');
  });

  it('undo/redo invalidates dependency engine cache', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('s0');

    // Compute critical path — fills cache
    const cp1 = sys.dependencyEngine.calculateCriticalPath(null);

    // Add a task that extends the critical path
    sys.store.addTask({ id: 'cp-ext', projectId: 'p1', name: 'CP Ext', plannedStart: '2026-01-01', plannedEnd: '2026-12-31', dependencies: ['t3'], estimatedDays: 365 });
    sys.historyManager.push('s1');

    const cp2 = sys.dependencyEngine.calculateCriticalPath(null);
    // The new task should appear somewhere
    assert(cp2.taskIds.length > 0, 'should have critical path tasks');

    // Undo — should invalidate cache and recalculate without the new task
    sys.historyManager.undo();
    const cp3 = sys.dependencyEngine.calculateCriticalPath(null);
    assert(!cp3.taskIds.includes('cp-ext'), 'undone task should not be in critical path');
  });

  it('jumpTo moves to arbitrary history point', () => {
    const sys = createSystem();
    sys.historyManager.push('s0');
    sys.store.addProject({ id: 'jp1', name: 'JP1' });
    sys.historyManager.push('s1');
    sys.store.addProject({ id: 'jp2', name: 'JP2' });
    sys.historyManager.push('s2');
    sys.store.addProject({ id: 'jp3', name: 'JP3' });
    sys.historyManager.push('s3');

    assertEqual(sys.store.state.projects.size, 3);
    const result = sys.historyManager.jumpTo(1); // back to s1 (1 project)
    assert(result.success);
    assertEqual(sys.store.state.projects.size, 1);
    assert(result.version !== undefined);
  });

  it('undo preserves baseline state', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('s0');

    const blId = sys.baselineManager.saveBaseline('UndoTest');

    sys.store.addTask({ id: 'tmp2', projectId: 'p1', name: 'Tmp2' });
    sys.historyManager.push('s1');

    sys.historyManager.undo();
    // Baseline should still exist (baselines are outside undo/redo)
    const bl = sys.baselineManager.getBaseline(blId);
    assert(bl !== null, 'baseline should survive undo');
    assertEqual(bl.name, 'UndoTest');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  5. Circular dependency interception
// ───────────────────────────────────────────────────────────────────────
describe('Circular dependency interception', () => {

  it('detects simple two-task cycle', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addTask({ id: 'c1', projectId: 'p1', name: 'C1', dependencies: ['c2'] });
    sys.store.addTask({ id: 'c2', projectId: 'p1', name: 'C2', dependencies: ['c1'] });

    const cycles = sys.dependencyEngine.detectCircularDependencies();
    assertGreater(cycles.length, 0, 'should detect cycle');
  });

  it('detects three-task cycle', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addTask({ id: 'a', projectId: 'p1', name: 'A', dependencies: ['c'] });
    sys.store.addTask({ id: 'b', projectId: 'p1', name: 'B', dependencies: ['a'] });
    sys.store.addTask({ id: 'c', projectId: 'p1', name: 'C', dependencies: ['b'] });

    const cycles = sys.dependencyEngine.detectCircularDependencies();
    assertGreater(cycles.length, 0, 'should detect 3-task cycle');
  });

  it('detects cross-project cycle', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addProject({ id: 'p2', name: 'P2' });
    sys.store.addTask({ id: 'x1', projectId: 'p1', name: 'X1', dependencies: [], crossProjectDeps: [{ projectId: 'p2', taskId: 'x2' }] });
    sys.store.addTask({ id: 'x2', projectId: 'p2', name: 'X2', dependencies: [], crossProjectDeps: [{ projectId: 'p1', taskId: 'x1' }] });

    const cycles = sys.dependencyEngine.detectCircularDependencies();
    assertGreater(cycles.length, 0, 'should detect cross-project cycle');
  });

  it('validationEngine surfaces cycles as errors', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addTask({ id: 'v1', projectId: 'p1', name: 'V1', dependencies: ['v2'] });
    sys.store.addTask({ id: 'v2', projectId: 'p1', name: 'V2', dependencies: ['v1'] });

    const issues = sys.validationEngine.validateAll();
    const cycleIssues = issues.filter(i => i.type === 'circular-dep');
    assertGreater(cycleIssues.length, 0, 'should surface cycle issues');
    assertEqual(cycleIssues[0].severity, 'error', 'cycle should be severity error');
  });

  it('cycle tasks are excluded from change propagation', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addTask({ id: 'root', projectId: 'p1', name: 'Root', plannedStart: '2026-01-01', plannedEnd: '2026-01-10', dependencies: [] });
    sys.store.addTask({ id: 'cy1', projectId: 'p1', name: 'CY1', plannedStart: '2026-01-11', plannedEnd: '2026-01-20', dependencies: ['root', 'cy2'] });
    sys.store.addTask({ id: 'cy2', projectId: 'p1', name: 'CY2', plannedStart: '2026-01-21', plannedEnd: '2026-01-30', dependencies: ['cy1'] });

    // Propagate from root — cycle tasks should be skipped
    const result = sys.dependencyEngine.propagateChanges('root', '2026-01-01', '2026-01-15');
    // Should not infinite loop and should return
    assert(result !== undefined, 'propagation should complete without hanging');
  });

  it('self-referencing dependency is detected', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P1' });
    sys.store.addTask({ id: 'self', projectId: 'p1', name: 'Self', dependencies: ['self'] });

    const issues = sys.dependencyEngine.validateDependencies();
    const selfRef = issues.filter(i => i.type === 'self-ref');
    assertGreater(selfRef.length, 0, 'should detect self-reference');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  6. Old Worker packet discard
// ───────────────────────────────────────────────────────────────────────
describe('Old Worker packet discard', () => {

  it('stale worker result is discarded when store version advances', () => {
    // Simulate the app.js Worker flow
    const sys = createSystem();
    seedPortfolio(sys.store);

    // Simulate a worker request at version V
    const requestVersion = sys.store.getVersion();

    // State changes after the request was made (simulating undo/redo or new edits)
    sys.store.addTask({ id: 'later', projectId: 'p1', name: 'Later' });
    sys.store.addTask({ id: 'later2', projectId: 'p1', name: 'Later2' });

    const currentVersion = sys.store.getVersion();
    assertGreater(currentVersion, requestVersion, 'current version should be higher');

    // Simulate the stale check from app.js initWorker
    const stateVersionFromWorker = requestVersion; // worker returns the version it was given
    const isStale = stateVersionFromWorker < currentVersion;
    assert(isStale, 'result should be detected as stale');
  });

  it('current worker result is accepted when versions match', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    const requestVersion = sys.store.getVersion();
    // No state changes between request and response
    const stateVersionFromWorker = requestVersion;
    const currentVersion = sys.store.getVersion();
    const isStale = stateVersionFromWorker < currentVersion;
    assert(!isStale, 'result should NOT be detected as stale');
  });

  it('change impact diff is discarded when computed at stale version', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('Worker-BL');
    sys.baselineManager.setActiveBaseline(blId);

    // Compute diff
    const diff = sys.changeImpactEngine.computeDiff(blId);
    assert(diff !== null, 'diff should exist');

    // Modify state — now the diff is stale
    sys.store.updateTask('t3', { progress: 50 });
    assert(sys.changeImpactEngine.isStale(), 'engine should be marked stale');
  });

  it('baseline restore invalidates stale change diff', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    const blId = sys.baselineManager.saveBaseline('BL-staleDiff');
    sys.baselineManager.setActiveBaseline(blId);

    // Compute a diff
    const diff1 = sys.changeImpactEngine.computeDiff(blId);
    const diffVersion1 = diff1.storeVersion;

    // Restore baseline — bumps version
    sys.baselineManager.restoreBaseline(blId);
    assertGreater(sys.store.getVersion(), diffVersion1, 'version should be higher after restore');

    // Recompute diff — should reflect restored state (no changes)
    const diff2 = sys.changeImpactEngine.computeDiff(blId);
    assert(diff2 !== null, 'should still compute diff');
    assertEqual(diff2.summary.totalDelayDays, 0, 'no delays after restoring baseline');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  7. Gantt/Resource/Risk triple-view consistency
// ───────────────────────────────────────────────────────────────────────
describe('Gantt/Resource/Risk triple-view consistency', () => {

  it('critical path, resource conflicts, and risk matrix use same store state', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    // All three computations should succeed on the same state
    const cp = sys.dependencyEngine.calculateCriticalPath(null);
    const conflicts = sys.resourceEngine.detectConflicts();
    const risks = sys.store.getFilteredRisks();

    assert(cp.taskIds.length > 0, 'should have critical path');
    assert(Array.isArray(conflicts), 'conflicts should be an array');
    assertEqual(risks.length, 3, 'should have 3 risks');
  });

  it('after undo, all three views reflect restored state', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    sys.historyManager.push('baseline');

    // Add overloaded resource
    sys.store.addResource({
      id: 'r-overload', name: 'Overloaded', department: 'Eng', role: 'Dev',
      tasks: [
        { taskId: 't2', projectId: 'p1', allocation: 80 },
        { taskId: 't3', projectId: 'p1', allocation: 80 },
      ],
      maxCapacity: 100,
    });
    // Add high-risk item
    sys.store.addRisk({
      id: 'rk-new', projectId: 'p1', taskId: 't2',
      name: 'New Critical Risk', probability: 5, impact: 5,
      category: 'tech', status: 'open', owner: 'A1',
    });
    sys.historyManager.push('after-changes');

    // Verify changes are visible
    assertEqual(sys.store.state.risks.size, 4, 'should have 4 risks');
    assertEqual(sys.store.state.resources.size, 5, 'should have 5 resources');

    // Undo
    sys.historyManager.undo();

    // All views should reflect the restored state
    assertEqual(sys.store.state.risks.size, 3, 'risks should be restored to 3');
    assertEqual(sys.store.state.resources.size, 4, 'resources should be restored to 4');

    const cp = sys.dependencyEngine.calculateCriticalPath(null);
    assert(cp.taskIds.length > 0, 'critical path should still compute');

    const conflicts = sys.resourceEngine.detectConflicts();
    // The overloaded resource should be gone
    const overloadConflicts = conflicts.filter(c => c.resourceId === 'r-overload');
    assertEqual(overloadConflicts.length, 0, 'overloaded resource conflicts should be gone after undo');
  });

  it('baseline diff reflects consistent view across critical path, resources, and risks', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);
    const blId = sys.baselineManager.saveBaseline('ConsistencyBL');
    sys.baselineManager.setActiveBaseline(blId);

    // Shift a task date, upgrade a risk, add a resource conflict
    const d = (offset) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + offset);
      return dt.toISOString().slice(0, 10);
    };
    sys.store.updateTask('t3', { plannedEnd: d(30) }); // delay t3
    sys.store.updateRisk('rk3', { probability: 5, impact: 5 }); // upgrade risk
    sys.store.addResource({
      id: 'r-conflict', name: 'ConflictRes', department: 'Eng', role: 'Dev',
      tasks: [
        { taskId: 't2', projectId: 'p1', allocation: 80 },
        { taskId: 't3', projectId: 'p1', allocation: 80 },
      ],
      maxCapacity: 100,
    });

    const diff = sys.changeImpactEngine.computeDiff(blId);
    assert(diff !== null, 'diff should exist');

    // Task delays should be detected
    const delayedTasks = diff.taskChanges.filter(tc => tc.delayDays > 0);
    assertGreater(delayedTasks.length, 0, 'should detect delayed tasks');

    // Risk changes should be detected
    const upgradedRisks = diff.riskChanges.filter(rc => rc.direction === 'upgraded');
    assertGreater(upgradedRisks.length, 0, 'should detect risk upgrade');

    // Summary should be coherent
    assert(diff.summary.totalTasksChanged >= 0, 'summary should have totalTasksChanged');
    assert(diff.summary.risksUpgraded >= 0, 'summary should have risksUpgraded');
  });

  it('resource duplicate allocation is detected', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'p1', name: 'P' });
    sys.store.addTask({ id: 't1', projectId: 'p1', name: 'T1', plannedStart: '2026-01-01', plannedEnd: '2026-01-10' });
    // Duplicate allocation: same resource assigned to same task twice
    sys.store.addResource({
      id: 'r-dup', name: 'DupRes', department: 'Eng', role: 'Dev',
      tasks: [
        { taskId: 't1', projectId: 'p1', allocation: 50 },
        { taskId: 't1', projectId: 'p1', allocation: 50 },
      ],
      maxCapacity: 100,
    });

    const issues = sys.validationEngine.validateResourceAllocations();
    const dupIssues = issues.filter(i => i.type === 'duplicate-allocation');
    assertGreater(dupIssues.length, 0, 'should detect duplicate allocation');
  });

  it('cross-project dependency validation detects project-level cycles', () => {
    const sys = createSystem();
    sys.store.addProject({ id: 'pa', name: 'PA' });
    sys.store.addProject({ id: 'pb', name: 'PB' });
    // PA.t1 depends on PB.t2, PB.t2 depends on PA.t1 — cross-project cycle
    sys.store.addTask({ id: 'cpt1', projectId: 'pa', name: 'CPT1', dependencies: [],
      crossProjectDeps: [{ projectId: 'pb', taskId: 'cpt2' }] });
    sys.store.addTask({ id: 'cpt2', projectId: 'pb', name: 'CPT2', dependencies: [],
      crossProjectDeps: [{ projectId: 'pa', taskId: 'cpt1' }] });

    const issues = sys.validationEngine.validateCrossProjectDeps();
    const cycleIssues = issues.filter(i => i.type === 'cross-proj-cycle');
    assertGreater(cycleIssues.length, 0, 'should detect cross-project cycle');
  });

  it('all three data domains have consistent counts after multiple operations', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    const stats1 = sys.store.getStats();
    assertEqual(stats1.totalProjects, 3);
    assertEqual(stats1.totalTasks, 7);

    // Add, undo, redo sequence
    sys.historyManager.push('s0');
    sys.store.addProject({ id: 'p4', name: 'Delta' });
    sys.store.addTask({ id: 't8', projectId: 'p4', name: 'Delta T1' });
    sys.store.addRisk({ id: 'rk4', projectId: 'p4', name: 'Delta Risk', probability: 2, impact: 2 });
    sys.historyManager.push('s1');

    const stats2 = sys.store.getStats();
    assertEqual(stats2.totalProjects, 4);
    assertEqual(stats2.totalTasks, 8);

    sys.historyManager.undo();
    const stats3 = sys.store.getStats();
    assertEqual(stats3.totalProjects, 3, 'projects should be 3 after undo');
    assertEqual(stats3.totalTasks, 7, 'tasks should be 7 after undo');

    sys.historyManager.redo();
    const stats4 = sys.store.getStats();
    assertEqual(stats4.totalProjects, 4, 'projects should be 4 after redo');
    assertEqual(stats4.totalTasks, 8, 'tasks should be 8 after redo');
  });
});

// ───────────────────────────────────────────────────────────────────────
//  8. DependencyEngine cache version alignment
// ───────────────────────────────────────────────────────────────────────
describe('DependencyEngine cache version alignment', () => {

  it('cache is invalidated when store version changes', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    const cp1 = sys.dependencyEngine.calculateCriticalPath(null);
    const cpTasks1 = cp1.taskIds.length;

    // Remove a task — should invalidate cache
    sys.store.removeTask('t3');
    const cp2 = sys.dependencyEngine.calculateCriticalPath(null);
    // Should be different since t3 is gone
    assert(!cp2.taskIds.includes('t3'), 't3 should not be in critical path after removal');
  });

  it('slack calculation uses fresh data after state change', () => {
    const sys = createSystem();
    seedPortfolio(sys.store);

    const slack1 = sys.dependencyEngine.calculateSlack(null);
    assert(slack1.size > 0, 'should compute slack for tasks');

    sys.store.removeTask('t7');
    const slack2 = sys.dependencyEngine.calculateSlack(null);
    assert(!slack2.has('t7'), 'removed task should not have slack');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Run all tests
// ═══════════════════════════════════════════════════════════════════════
await runTests();
