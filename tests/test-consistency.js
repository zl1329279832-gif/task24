/**
 * test-consistency.js
 *
 * Verifies:
 *  1. Import → undo → redo snapshot consistency (all 4 collections)
 *  2. Circular dependency detection (pre-import validation + engine)
 *  3. Cross-project dependency validation
 *  4. Resource overload warnings
 *  5. Risk level consistency checks
 *  6. State version tracking & engine cache invalidation
 *  7. Export report uses same snapshot as store
 *
 * Run:  node --experimental-vm-modules tests/test-consistency.js
 */

import { Store } from '../js/core/store.js';
import { HistoryManager } from '../js/core/history-manager.js';
import { DependencyEngine } from '../js/core/dependency-engine.js';
import { ResourceEngine } from '../js/engine/resource-engine.js';
import { RiskEngine } from '../js/engine/risk-engine.js';
import { CSVParser } from '../js/core/csv-parser.js';
import assert from 'node:assert/strict';

// ─── Helpers ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✕ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✕ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function seedData(store) {
  store.addProject({ id: 'p1', name: 'Alpha', department: 'Eng', projectManager: 'PM1' });
  store.addProject({ id: 'p2', name: 'Beta', department: 'IT', projectManager: 'PM2' });

  store.addTask({ id: 't1', projectId: 'p1', name: 'Task A', plannedStart: '2026-01-01', plannedEnd: '2026-01-10', dependencies: [] });
  store.addTask({ id: 't2', projectId: 'p1', name: 'Task B', plannedStart: '2026-01-11', plannedEnd: '2026-01-20', dependencies: ['t1'] });
  store.addTask({ id: 't3', projectId: 'p2', name: 'Task C', plannedStart: '2026-01-15', plannedEnd: '2026-01-25', dependencies: [], crossProjectDeps: [{ projectId: 'p1', taskId: 't2' }] });

  store.addResource({ id: 'r1', name: 'Alice', department: 'Eng', role: 'Dev', maxCapacity: 100, tasks: [
    { taskId: 't1', projectId: 'p1', allocation: 80 },
    { taskId: 't2', projectId: 'p1', allocation: 60 },
  ]});

  store.addRisk({ id: 'rk1', projectId: 'p1', name: 'Scope creep', probability: 4, impact: 4, level: 'high', status: 'open', owner: 'PM1' });
  store.addRisk({ id: 'rk2', projectId: 'p2', name: 'Data loss', probability: 2, impact: 5, level: 'high', status: 'open', owner: 'PM2' });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 1. State Version Tracking ===');
// ═══════════════════════════════════════════════════════════════════

test('version increments on add', () => {
  const store = new Store();
  const v0 = store.state.version;
  store.addProject({ id: 'x', name: 'X' });
  assert.ok(store.state.version > v0, 'version should increase after add');
});

test('version increments on update', () => {
  const store = new Store();
  store.addProject({ id: 'x', name: 'X' });
  const v1 = store.state.version;
  store.updateProject('x', { name: 'Y' });
  assert.ok(store.state.version > v1, 'version should increase after update');
});

test('version increments on remove', () => {
  const store = new Store();
  store.addProject({ id: 'x', name: 'X' });
  const v1 = store.state.version;
  store.removeProject('x');
  assert.ok(store.state.version > v1, 'version should increase after remove');
});

test('version increments on restoreFromSnapshot', () => {
  const store = new Store();
  store.addProject({ id: 'x', name: 'X' });
  const snap = store.getSnapshot();
  store.addProject({ id: 'y', name: 'Y' });
  const v2 = store.state.version;
  store.restoreFromSnapshot(snap);
  assert.ok(store.state.version > v2, 'version should increase after restore');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 2. Snapshot / Restore Consistency ===');
// ═══════════════════════════════════════════════════════════════════

test('getSnapshot captures all collections', () => {
  const store = new Store();
  seedData(store);
  const snap = store.getSnapshot();
  assert.equal(snap.projects.length, 2);
  assert.equal(snap.tasks.length, 3);
  assert.equal(snap.resources.length, 1);
  assert.equal(snap.risks.length, 2);
});

test('restoreFromSnapshot atomically replaces all data', () => {
  const store = new Store();
  seedData(store);
  const snap = store.getSnapshot();

  // Mutate everything
  store.addProject({ id: 'p3', name: 'Gamma' });
  store.addTask({ id: 't4', projectId: 'p3', name: 'Task D' });
  store.addRisk({ id: 'rk3', projectId: 'p3', name: 'New risk' });
  store.addResource({ id: 'r2', name: 'Bob', tasks: [] });
  assert.equal(store.state.projects.size, 3);
  assert.equal(store.state.tasks.size, 4);

  // Restore
  store.restoreFromSnapshot(snap);
  assert.equal(store.state.projects.size, 2, 'projects restored');
  assert.equal(store.state.tasks.size, 3, 'tasks restored');
  assert.equal(store.state.risks.size, 2, 'risks restored');
  assert.equal(store.state.resources.size, 1, 'resources restored');
});

test('restore emits restore event', () => {
  const store = new Store();
  seedData(store);
  const snap = store.getSnapshot();

  let gotRestore = false;
  store.subscribe((e) => { if (e.type === 'restore') gotRestore = true; });

  store.restoreFromSnapshot(snap);
  assert.ok(gotRestore, 'should emit restore event');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 3. Import → Undo → Redo Consistency ===');
// ═══════════════════════════════════════════════════════════════════

await asyncTest('undo after import reverts ALL collections atomically', async () => {
  const store = new Store();
  const history = new HistoryManager(store, { autoCapture: false });

  seedData(store);
  history.push('seed');

  const preProjects = store.state.projects.size;
  const preTasks = store.state.tasks.size;
  const preRisks = store.state.risks.size;
  const preResources = store.state.resources.size;

  // Simulate import
  history.checkpoint('pre-import');
  store.importData({
    projects: [{ id: 'imp-p', name: 'Imported' }],
    tasks: [{ id: 'imp-t', projectId: 'imp-p', name: 'Imported Task', dependencies: [] }],
    risks: [{ id: 'imp-r', projectId: 'imp-p', name: 'Imported Risk', probability: 3, impact: 3 }],
    resources: [{ id: 'imp-res', name: 'Imported Res', tasks: [] }],
  });
  history.push('import');

  assert.ok(store.state.projects.size > preProjects, 'post-import has more projects');
  assert.ok(store.state.tasks.size > preTasks, 'post-import has more tasks');

  // Undo
  const undoResult = history.undo();
  assert.ok(undoResult.success, 'undo succeeds');
  assert.equal(store.state.projects.size, preProjects, 'projects restored after undo');
  assert.equal(store.state.tasks.size, preTasks, 'tasks restored after undo');
  assert.equal(store.state.risks.size, preRisks, 'risks restored after undo');
  assert.equal(store.state.resources.size, preResources, 'resources restored after undo');

  // Redo
  const redoResult = history.redo();
  assert.ok(redoResult.success, 'redo succeeds');
  assert.ok(store.state.projects.size > preProjects, 'projects re-imported after redo');
  assert.ok(store.state.tasks.size > preTasks, 'tasks re-imported after redo');
});

await asyncTest('undo reverts resource allocations together with tasks', async () => {
  const store = new Store();
  const history = new HistoryManager(store, { autoCapture: false });

  store.addProject({ id: 'p1', name: 'P1' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'T1', plannedStart: '2026-01-01', plannedEnd: '2026-01-10' });
  store.addResource({ id: 'r1', name: 'A', tasks: [{ taskId: 't1', projectId: 'p1', allocation: 50 }], maxCapacity: 100 });
  history.push('initial');

  // Import more resources
  history.checkpoint('pre-import');
  store.importData({
    resources: [{ id: 'r-new', name: 'B', tasks: [{ taskId: 't1', projectId: 'p1', allocation: 80 }], maxCapacity: 100 }],
  });
  history.push('resource-import');

  assert.equal(store.state.resources.size, 2, 'two resources after import');

  // Undo — both task deps AND resource allocations must revert
  history.undo();
  assert.equal(store.state.resources.size, 1, 'resources reverted');
  const r = store.state.resources.get('r1');
  assert.ok(r, 'original resource preserved');
  assert.equal(r.tasks.length, 1, 'original allocations preserved');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 4. Circular Dependency Detection ===');
// ═══════════════════════════════════════════════════════════════════

test('detectCircularDependencies finds cycles', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: ['t2'] });
  store.addTask({ id: 't2', projectId: 'p1', name: 'B', dependencies: ['t3'] });
  store.addTask({ id: 't3', projectId: 'p1', name: 'C', dependencies: ['t1'] });

  const cycles = deps.detectCircularDependencies();
  assert.ok(cycles.length > 0, 'should detect cycle');
  assert.ok(cycles[0].description.includes('Circular'), 'description mentions circular');
});

test('no false positives on acyclic graph', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: [] });
  store.addTask({ id: 't2', projectId: 'p1', name: 'B', dependencies: ['t1'] });
  store.addTask({ id: 't3', projectId: 'p1', name: 'C', dependencies: ['t1', 't2'] });

  const cycles = deps.detectCircularDependencies();
  assert.equal(cycles.length, 0, 'no cycles in acyclic graph');
});

test('CSV validateImportData detects circular deps', () => {
  const data = {
    tasks: [
      { id: 'x1', name: 'X1', dependencies: ['x2'] },
      { id: 'x2', name: 'X2', dependencies: ['x3'] },
      { id: 'x3', name: 'X3', dependencies: ['x1'] },
    ],
  };
  const result = CSVParser.validateImportData(data);
  assert.ok(result.errors.length > 0, 'should report cycle error');
  assert.ok(result.errors[0].includes('循环依赖'), 'error mentions 循环依赖');
});

test('CSV validateImportData detects self-reference', () => {
  const data = { tasks: [{ id: 'x1', name: 'X1', dependencies: ['x1'] }] };
  const result = CSVParser.validateImportData(data);
  assert.ok(result.errors.length > 0, 'should report self-ref error');
  assert.ok(result.errors[0].includes('依赖自身'), 'error mentions 依赖自身');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 5. Cross-Project Dependency Validation ===');
// ═══════════════════════════════════════════════════════════════════

test('CSV validateImportData warns on dangling cross-project deps', () => {
  const data = {
    tasks: [
      { id: 't1', name: 'T1', dependencies: [], crossProjectDeps: [{ projectId: 'unknown-proj', taskId: 'unknown-task' }] },
    ],
  };
  const result = CSVParser.validateImportData(data);
  assert.ok(result.warnings.length >= 2, 'should warn about unknown project and task');
});

test('CSV validateImportData accepts valid cross-project deps against store', () => {
  const store = new Store();
  store.addProject({ id: 'ext-p', name: 'External' });
  store.addTask({ id: 'ext-t', projectId: 'ext-p', name: 'External Task' });

  const data = {
    tasks: [
      { id: 't1', name: 'T1', dependencies: [], crossProjectDeps: [{ projectId: 'ext-p', taskId: 'ext-t' }] },
    ],
  };
  const result = CSVParser.validateImportData(data, store);
  const crossWarnings = result.warnings.filter(w => w.includes('跨项目'));
  assert.equal(crossWarnings.length, 0, 'no warnings for valid cross-project deps');
});

test('DependencyEngine.getCrossProjectDeps returns cross-project links', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'Alpha' });
  store.addProject({ id: 'p2', name: 'Beta' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: [] });
  store.addTask({ id: 't2', projectId: 'p2', name: 'B', dependencies: [], crossProjectDeps: [{ projectId: 'p1', taskId: 't1' }] });

  const cpds = deps.getCrossProjectDeps();
  assert.ok(cpds.length > 0, 'should detect cross-project dep');
  assert.equal(cpds[0].fromTask.id, 't1');
  assert.equal(cpds[0].toTask.id, 't2');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 6. Resource Overload Detection ===');
// ═══════════════════════════════════════════════════════════════════

test('CSV validateImportData warns on resource overload', () => {
  const data = {
    resources: [
      { id: 'r1', name: 'Alice', maxCapacity: 100, tasks: [
        { taskId: 't1', allocation: 60 },
        { taskId: 't2', allocation: 60 },
      ]},
    ],
  };
  const result = CSVParser.validateImportData(data);
  assert.ok(result.warnings.some(w => w.includes('超过最大产能')), 'should warn about overload');
});

test('ResourceEngine detects overloaded resources', () => {
  const store = new Store();
  const engine = new ResourceEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'T1', plannedStart: '2026-01-06', plannedEnd: '2026-01-10' }); // Mon-Fri
  store.addTask({ id: 't2', projectId: 'p1', name: 'T2', plannedStart: '2026-01-06', plannedEnd: '2026-01-10' });
  store.addResource({ id: 'r1', name: 'Alice', maxCapacity: 100, tasks: [
    { taskId: 't1', projectId: 'p1', allocation: 70 },
    { taskId: 't2', projectId: 'p1', allocation: 70 },
  ]});

  const overloaded = engine.findOverloadedResources();
  assert.ok(overloaded.length > 0, 'should detect overloaded resource');
  assert.equal(overloaded[0].resourceName, 'Alice');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 7. Risk Level Consistency ===');
// ═══════════════════════════════════════════════════════════════════

test('CSV validateImportData warns on inconsistent risk level', () => {
  const data = {
    risks: [
      { id: 'rk1', name: 'Test Risk', probability: 5, impact: 5, level: 'low' }, // 25 should be critical
    ],
  };
  const result = CSVParser.validateImportData(data);
  assert.ok(result.warnings.some(w => w.includes('不一致')), 'should warn about level mismatch');
});

test('store auto-calculates risk level on add', () => {
  const store = new Store();
  store.addRisk({ id: 'rk1', projectId: 'p1', name: 'R', probability: 5, impact: 5 });
  const risk = store.state.risks.get('rk1');
  assert.equal(risk.level, 'critical', 'P5×I5=25 should be critical');
});

test('store recalculates risk level on update', () => {
  const store = new Store();
  store.addRisk({ id: 'rk1', projectId: 'p1', name: 'R', probability: 5, impact: 5 });
  store.updateRisk('rk1', { probability: 1, impact: 1 });
  const risk = store.state.risks.get('rk1');
  assert.equal(risk.level, 'low', 'P1×I1=1 should be low');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 8. Engine Cache Invalidation on Restore ===');
// ═══════════════════════════════════════════════════════════════════

test('DependencyEngine invalidates cache on restore', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', plannedStart: '2026-01-01', plannedEnd: '2026-01-10', dependencies: [], estimatedDays: 10 });
  store.addTask({ id: 't2', projectId: 'p1', name: 'B', plannedStart: '2026-01-11', plannedEnd: '2026-01-20', dependencies: ['t1'], estimatedDays: 10 });

  // Compute critical path for all tasks (caches internally)
  const cp1 = deps.calculateCriticalPath(null);

  // Take snapshot, then add a third task
  const snap = store.getSnapshot();
  store.addTask({ id: 't3', projectId: 'p1', name: 'C', plannedStart: '2026-01-21', plannedEnd: '2026-02-01', dependencies: ['t2'], estimatedDays: 10 });

  // Verify t3 is now known to the engine
  assert.ok(store.state.tasks.has('t3'), 't3 exists before restore');

  // Restore to pre-t3 state
  store.restoreFromSnapshot(snap);

  assert.ok(!store.state.tasks.has('t3'), 't3 removed after restore');

  // Critical path should not include t3 (cache must have been invalidated)
  const cp2 = deps.calculateCriticalPath(null);
  assert.ok(!cp2.taskIds.includes('t3'), 'restored CP should not include removed task');
  assert.equal(store.state.tasks.size, 2, 'only 2 tasks after restore');
});

test('ResourceEngine invalidates cache on restore', () => {
  const store = new Store();
  const resEngine = new ResourceEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'T1', plannedStart: '2026-01-06', plannedEnd: '2026-01-10' });
  store.addResource({ id: 'r1', name: 'Alice', maxCapacity: 100, tasks: [
    { taskId: 't1', projectId: 'p1', allocation: 50 },
  ]});

  const snap = store.getSnapshot();

  // Add overload
  store.addTask({ id: 't2', projectId: 'p1', name: 'T2', plannedStart: '2026-01-06', plannedEnd: '2026-01-10' });
  store.updateResource('r1', { tasks: [
    { taskId: 't1', projectId: 'p1', allocation: 50 },
    { taskId: 't2', projectId: 'p1', allocation: 80 },
  ]});

  const overBefore = resEngine.findOverloadedResources();
  assert.ok(overBefore.length > 0, 'overloaded before restore');

  // Restore
  store.restoreFromSnapshot(snap);

  const overAfter = resEngine.findOverloadedResources();
  assert.equal(overAfter.length, 0, 'no overload after restore');
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 9. Export Report Consistency ===');
// ═══════════════════════════════════════════════════════════════════

test('HTML report includes cycle warnings when passed', () => {
  const store = new Store();
  store.addProject({ id: 'p1', name: 'P' });
  store.addRisk({ id: 'rk1', projectId: 'p1', name: 'R', probability: 3, impact: 3 });

  const engine = new RiskEngine(store);
  const html = engine.exportReportHTML(null, {
    cycles: [{ description: 'A → B → A' }],
    resourceOverloads: [{ resourceName: 'Alice', totalAllocation: 150, maxCapacity: 100, overloadPercentage: 50 }],
    riskLevelChanges: ['Risk "X": stated low, computed high'],
  });

  assert.ok(html.includes('Circular Dependencies'), 'report includes cycle section');
  assert.ok(html.includes('A → B → A'), 'report includes cycle detail');
  assert.ok(html.includes('Resource Overloads'), 'report includes overload section');
  assert.ok(html.includes('Alice'), 'report includes overloaded resource');
  assert.ok(html.includes('Risk Level Inconsistencies'), 'report includes risk level section');
});

test('HTML report omits extra sections when no issues', () => {
  const store = new Store();
  store.addProject({ id: 'p1', name: 'P' });
  store.addRisk({ id: 'rk1', projectId: 'p1', name: 'R', probability: 3, impact: 3 });

  const engine = new RiskEngine(store);
  const html = engine.exportReportHTML(null, {});

  assert.ok(!html.includes('Circular Dependencies'), 'no cycle section');
  assert.ok(!html.includes('Resource Overloads'), 'no overload section');
});

test('getSnapshot and exportData produce equivalent data', () => {
  const store = new Store();
  seedData(store);

  const snapshot = store.getSnapshot();
  const exported = store.exportData();

  assert.equal(snapshot.projects.length, exported.projects.length);
  assert.equal(snapshot.tasks.length, exported.tasks.length);
  assert.equal(snapshot.risks.length, exported.risks.length);
  assert.equal(snapshot.resources.length, exported.resources.length);

  // Verify IDs match
  const snapPIds = snapshot.projects.map(p => p.id).sort();
  const expPIds = exported.projects.map(p => p.id).sort();
  assert.deepEqual(snapPIds, expPIds);
});

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== 10. Dependency Validation ===');
// ═══════════════════════════════════════════════════════════════════

test('validateDependencies finds dangling refs', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: ['nonexistent'] });

  const issues = deps.validateDependencies();
  assert.ok(issues.some(i => i.type === 'dangling-ref'), 'should find dangling ref');
});

test('validateDependencies finds self-refs', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: ['t1'] });

  const issues = deps.validateDependencies();
  assert.ok(issues.some(i => i.type === 'self-ref'), 'should find self-ref');
});

test('validateDependencies finds cycles', () => {
  const store = new Store();
  const deps = new DependencyEngine(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'A', dependencies: ['t2'] });
  store.addTask({ id: 't2', projectId: 'p1', name: 'B', dependencies: ['t1'] });

  const issues = deps.validateDependencies();
  assert.ok(issues.some(i => i.type === 'cycle'), 'should find cycle');
});

// ═══════════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
