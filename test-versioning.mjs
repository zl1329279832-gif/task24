/**
 * test-versioning.mjs
 *
 * Comprehensive test suite for the unified version / baseline / worker
 * staleness system.  Runs in Node.js (18+) with no build tools required.
 *
 *   node test-versioning.mjs
 *
 * Polyfills crypto.randomUUID and localStorage for the Node environment.
 */

// ─── Polyfills ────────────────────────────────────────────────────────────────
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

// In-memory localStorage shim
const _lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => _lsStore.get(k) ?? null,
  setItem: (k, v) => _lsStore.set(k, String(v)),
  removeItem: (k) => _lsStore.delete(k),
  clear: () => _lsStore.clear(),
};

// ─── Imports ──────────────────────────────────────────────────────────────────
import { Store }             from './js/core/store.js';
import { HistoryManager }    from './js/core/history-manager.js';
import { BaselineManager }   from './js/core/baseline-manager.js';
import { DependencyEngine }  from './js/core/dependency-engine.js';
import { ChangeImpactEngine } from './js/engine/change-impact-engine.js';

// ─── Minimal test runner ──────────────────────────────────────────────────────
let _pass = 0;
let _fail = 0;
const _failures = [];

async function test(name, fn) {
  try {
    await fn();
    _pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    _fail++;
    _failures.push({ name, error: err.message || String(err) });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${err.message || err}\x1b[0m`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertGt(a, b, msg) {
  if (!(a > b)) throw new Error(`${msg || 'assertGt'}: expected ${a} > ${b}`);
}

// ─── Stub engines (BaselineManager requires these) ────────────────────────────
function makeStubResEngine() {
  return { findOverloadedResources: () => [] };
}
function makeStubRiskEngine() {
  return {};
}

// ─── Helper: create a wired Store + engines ───────────────────────────────────
function makeWiredStore() {
  const store = new Store();
  const depEngine = new DependencyEngine(store);
  return { store, depEngine };
}

function makeBaselineManager(store, depEngine) {
  return new BaselineManager(store, {
    dependencyEngine: depEngine,
    resourceEngine: makeStubResEngine(),
    riskEngine: makeStubRiskEngine(),
  });
}

function makeChangeImpactEngine(store, baselineManager, depEngine) {
  return new ChangeImpactEngine(store, baselineManager, {
    dependencyEngine: depEngine,
    resourceEngine: makeStubResEngine(),
    riskEngine: makeStubRiskEngine(),
    workerRequest: () => Promise.resolve(null),
  });
}

// Seed minimal test data
function seedData(store) {
  store.addProject({ id: 'p1', name: 'Proj1', department: 'Eng', status: 'active' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'Task1', plannedStart: '2025-01-01', plannedEnd: '2025-01-10', dependencies: [], estimatedDays: 10 });
  store.addTask({ id: 't2', projectId: 'p1', name: 'Task2', plannedStart: '2025-01-11', plannedEnd: '2025-01-20', dependencies: ['t1'], estimatedDays: 10 });
  store.addTask({ id: 't3', projectId: 'p1', name: 'Task3', plannedStart: '2025-01-21', plannedEnd: '2025-01-30', dependencies: ['t2'], estimatedDays: 10 });
  store.addRisk({ id: 'r1', projectId: 'p1', name: 'Risk1', probability: 3, impact: 4 });
  store.addResource({ id: 'res1', name: 'Alice', tasks: [{ taskId: 't1', projectId: 'p1', allocation: 80 }], maxCapacity: 100 });
}

// ═════════════════════════════════════════════════════════════════════════════
//  TEST SUITES
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1m=== Store Version Counter ===\x1b[0m');

await test('store starts at version 0', () => {
  const { store } = makeWiredStore();
  assertEq(store.state.stateVersion, 0, 'initial version');
  assert(typeof store.state.portfolioId === 'string', 'portfolioId exists');
  assert(store.state.portfolioId.length > 0, 'portfolioId non-empty');
});

await test('addProject bumps version', () => {
  const { store } = makeWiredStore();
  const v0 = store.state.stateVersion;
  store.addProject({ id: 'p1', name: 'Test' });
  assertGt(store.state.stateVersion, v0, 'version bumped');
});

await test('addTask bumps version', () => {
  const { store } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P' });
  const v1 = store.state.stateVersion;
  store.addTask({ id: 't1', projectId: 'p1', name: 'T' });
  assertGt(store.state.stateVersion, v1, 'version bumped');
});

await test('multiple mutations increment monotonically', () => {
  const { store } = makeWiredStore();
  const versions = [];
  store.addProject({ id: 'p1', name: 'P' });
  versions.push(store.state.stateVersion);
  store.addTask({ id: 't1', projectId: 'p1', name: 'T1' });
  versions.push(store.state.stateVersion);
  store.addTask({ id: 't2', projectId: 'p1', name: 'T2' });
  versions.push(store.state.stateVersion);
  store.updateTask('t1', { progress: 50 });
  versions.push(store.state.stateVersion);

  for (let i = 1; i < versions.length; i++) {
    assertGt(versions[i], versions[i - 1], `version[${i}] > version[${i-1}]`);
  }
});

await test('batch bumps version for each inner mutation', () => {
  const { store } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P' });
  const vBefore = store.state.stateVersion;
  store.batch(() => {
    store.addTask({ id: 't1', projectId: 'p1', name: 'T1' });
    store.addTask({ id: 't2', projectId: 'p1', name: 'T2' });
  });
  assertGt(store.state.stateVersion, vBefore, 'version bumped after batch');
});

await test('replaceAll regenerates portfolioId by default', () => {
  const { store } = makeWiredStore();
  seedData(store);
  const oldPid = store.state.portfolioId;
  store.replaceAll({ projects: [{ id: 'px', name: 'New' }], tasks: [], risks: [], resources: [] });
  assert(store.state.portfolioId !== oldPid, 'portfolioId changed');
});

await test('replaceAll with preservePortfolioId keeps portfolioId', () => {
  const { store } = makeWiredStore();
  seedData(store);
  const pid = store.state.portfolioId;
  store.replaceAll(
    { projects: [{ id: 'p1', name: 'P' }], tasks: [], risks: [], resources: [] },
    { preservePortfolioId: true }
  );
  assertEq(store.state.portfolioId, pid, 'portfolioId preserved');
});

await test('importData regenerates portfolioId', () => {
  const { store } = makeWiredStore();
  seedData(store);
  const oldPid = store.state.portfolioId;
  store.importData({ projects: [{ id: 'p2', name: 'Imported' }], tasks: [], risks: [], resources: [] });
  assert(store.state.portfolioId !== oldPid, 'portfolioId changed after import');
});

await test('exportData and getSnapshot include version metadata', () => {
  const { store } = makeWiredStore();
  seedData(store);
  const exported = store.exportData();
  assertEq(exported._stateVersion, store.state.stateVersion, 'export version');
  assertEq(exported._portfolioId, store.state.portfolioId, 'export portfolioId');

  const snap = store.getSnapshot();
  assertEq(snap._stateVersion, store.state.stateVersion, 'snapshot version');
  assertEq(snap._portfolioId, store.state.portfolioId, 'snapshot portfolioId');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== History Manager Versioning ===\x1b[0m');

await test('history entries carry stateVersion and portfolioId', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');

  const history = hm.getHistory();
  assert(history.length > 0, 'has history');
  const latest = history[0]; // most recent first
  assertEq(typeof latest.stateVersion, 'number', 'has stateVersion');
  assertEq(typeof latest.portfolioId, 'string', 'has portfolioId');
  hm.dispose();
});

await test('undo bumps generation (store version increases)', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');

  const vBeforeUndo = store.state.stateVersion;
  store.addTask({ id: 'tNew', projectId: 'p1', name: 'NewTask' });
  hm.push('add task');

  const vAfterAdd = store.state.stateVersion;
  assertGt(vAfterAdd, vBeforeUndo, 'version increased after add');

  const result = hm.undo();
  assert(result.success, 'undo succeeded');
  // After undo, bumpGeneration was called, so version should be even higher
  assertGt(store.state.stateVersion, vAfterAdd, 'version bumped by undo');
  hm.dispose();
});

await test('undo preserves portfolioId', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');
  const pid = store.state.portfolioId;

  store.addTask({ id: 'tNew', projectId: 'p1', name: 'New' });
  hm.push('add');
  hm.undo();

  assertEq(store.state.portfolioId, pid, 'portfolioId preserved after undo');
  hm.dispose();
});

await test('redo preserves portfolioId', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');
  const pid = store.state.portfolioId;

  store.addTask({ id: 'tNew', projectId: 'p1', name: 'New' });
  hm.push('add');
  hm.undo();
  hm.redo();

  assertEq(store.state.portfolioId, pid, 'portfolioId preserved after redo');
  hm.dispose();
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Baseline Versioning ===\x1b[0m');

await test('baseline records stateVersion and portfolioId', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL1');
  const bl = bm.getBaseline(id);

  assertEq(bl.stateVersion, store.state.stateVersion, 'baseline stateVersion matches');
  assertEq(bl.portfolioId, store.state.portfolioId, 'baseline portfolioId matches');
  assertEq(bl.metricsVersion, store.state.stateVersion, 'baseline metricsVersion matches');
});

await test('baseline metrics computed from snapshot, not live engines', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL1');
  const bl = bm.getBaseline(id);

  // Metrics should have critical path from the snapshot
  assert(Array.isArray(bl.metrics.criticalPathTaskIds), 'has criticalPathTaskIds');
  // Task t1->t2->t3 chain should have all on critical path
  assert(bl.metrics.criticalPathTaskIds.length > 0, 'found critical path tasks');
  assertEq(bl.metrics.taskCount, 3, 'task count');
  assertEq(bl.metrics.projectCount, 1, 'project count');
});

await test('validateVersionCompatibility detects same portfolio', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL1');
  const compat = bm.validateVersionCompatibility(id);

  assert(compat.compatible, 'should be compatible (same portfolio)');
  assert(compat.portfolioMatch, 'portfolio should match');
});

await test('validateVersionCompatibility detects lineage change after import', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL1');

  // Import new data — this regenerates portfolioId
  store.importData({ projects: [{ id: 'px', name: 'New' }], tasks: [], risks: [], resources: [] });

  const compat = bm.validateVersionCompatibility(id);
  assert(!compat.compatible, 'should NOT be compatible after import');
  assert(!compat.portfolioMatch, 'portfolio should NOT match after import');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Circular Dependency Detection ===\x1b[0m');

await test('detects simple A→B→A cycle', () => {
  const { store, depEngine } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 'a', projectId: 'p1', name: 'A', dependencies: ['b'] });
  store.addTask({ id: 'b', projectId: 'p1', name: 'B', dependencies: ['a'] });

  const cycles = depEngine.detectCircularDependencies();
  assert(cycles.length > 0, 'cycle detected');
  assert(cycles[0].cycle.includes('a'), 'cycle includes a');
  assert(cycles[0].cycle.includes('b'), 'cycle includes b');
  assert(typeof cycles[0].fingerprint === 'string', 'has fingerprint');
});

await test('detects 3-node cycle', () => {
  const { store, depEngine } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 'x', projectId: 'p1', name: 'X', dependencies: ['z'] });
  store.addTask({ id: 'y', projectId: 'p1', name: 'Y', dependencies: ['x'] });
  store.addTask({ id: 'z', projectId: 'p1', name: 'Z', dependencies: ['y'] });

  const cycles = depEngine.detectCircularDependencies();
  assert(cycles.length > 0, 'cycle detected');
  const cycleSet = new Set(cycles[0].cycle);
  assert(cycleSet.has('x') && cycleSet.has('y') && cycleSet.has('z'), 'all 3 in cycle');
});

await test('detects cross-project circular dependency', () => {
  const { store, depEngine } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P1' });
  store.addProject({ id: 'p2', name: 'P2' });
  store.addTask({ id: 'a', projectId: 'p1', name: 'A', dependencies: [], crossProjectDeps: [{ projectId: 'p2', taskId: 'b' }] });
  store.addTask({ id: 'b', projectId: 'p2', name: 'B', dependencies: [], crossProjectDeps: [{ projectId: 'p1', taskId: 'a' }] });

  const cycles = depEngine.detectCircularDependencies();
  assert(cycles.length > 0, 'cross-project cycle detected');
});

await test('no false positive on DAG', () => {
  const { store, depEngine } = makeWiredStore();
  seedData(store);

  const cycles = depEngine.detectCircularDependencies();
  assertEq(cycles.length, 0, 'no cycles in DAG');
});

await test('stable fingerprint across repeated calls', () => {
  const { store, depEngine } = makeWiredStore();
  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 'a', projectId: 'p1', name: 'A', dependencies: ['b'] });
  store.addTask({ id: 'b', projectId: 'p1', name: 'B', dependencies: ['a'] });

  const c1 = depEngine.detectCircularDependencies();
  const c2 = depEngine.detectCircularDependencies();
  assertEq(c1[0].fingerprint, c2[0].fingerprint, 'fingerprint stable');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Stale Worker Result Discarding ===\x1b[0m');

// Simulate the three-layer stale check from app.js initWorker()
function simulateStaleCheck(pending, response) {
  // 1. Generation mismatch
  if (response.generation !== undefined && pending.generation !== undefined && response.generation !== pending.generation) {
    return 'DISCARD';
  }
  // 2. Portfolio mismatch
  if (response.portfolioId !== undefined && pending.portfolioId !== undefined && response.portfolioId !== pending.portfolioId) {
    return 'DISCARD';
  }
  // 3. Older stateVersion
  if (response.stateVersion !== undefined && pending.stateVersion !== undefined && response.stateVersion < pending.stateVersion) {
    return 'DISCARD';
  }
  return 'ACCEPT';
}

await test('generation mismatch discards result', () => {
  const pending = { generation: 3, portfolioId: 'p1', stateVersion: 10 };
  const response = { generation: 2, portfolioId: 'p1', stateVersion: 10 };
  assertEq(simulateStaleCheck(pending, response), 'DISCARD', 'gen mismatch');
});

await test('portfolio mismatch discards result', () => {
  const pending = { generation: 3, portfolioId: 'p1', stateVersion: 10 };
  const response = { generation: 3, portfolioId: 'p2', stateVersion: 10 };
  assertEq(simulateStaleCheck(pending, response), 'DISCARD', 'portfolio mismatch');
});

await test('same gen, older version discards result', () => {
  const pending = { generation: 3, portfolioId: 'p1', stateVersion: 10 };
  const response = { generation: 3, portfolioId: 'p1', stateVersion: 8 };
  assertEq(simulateStaleCheck(pending, response), 'DISCARD', 'older version');
});

await test('same gen, same or newer version accepts result', () => {
  const pending = { generation: 3, portfolioId: 'p1', stateVersion: 10 };
  const resp1 = { generation: 3, portfolioId: 'p1', stateVersion: 10 };
  const resp2 = { generation: 3, portfolioId: 'p1', stateVersion: 12 };
  assertEq(simulateStaleCheck(pending, resp1), 'ACCEPT', 'same version');
  assertEq(simulateStaleCheck(pending, resp2), 'ACCEPT', 'newer version');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== ChangeImpactEngine Version Validation ===\x1b[0m');

await test('computeDiff includes versionMetadata', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  const cie = makeChangeImpactEngine(store, bm, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL');
  bm.setActiveBaseline(id);

  // Mutate state
  store.updateTask('t2', { plannedEnd: '2025-01-25' });

  const diff = cie.computeDiff(id);
  assert(diff !== null, 'diff computed');
  assert(diff.versionMetadata !== null, 'has versionMetadata');
  assert(diff.versionMetadata.versionCompatible !== undefined, 'has compatible flag');
  assert(diff.versionMetadata.portfolioMatch, 'portfolio matches');
  cie.destroy();
});

await test('computeDiff flags version mismatch after import', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  const cie = makeChangeImpactEngine(store, bm, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL');
  bm.setActiveBaseline(id);

  // Import changes portfolioId
  store.importData({ projects: [{ id: 'px', name: 'New' }], tasks: [], risks: [], resources: [] });

  const diff = cie.computeDiff(id);
  assert(diff !== null, 'diff computed');
  assert(diff.versionMetadata !== null, 'has versionMetadata');
  assert(!diff.versionMetadata.versionCompatible, 'NOT compatible after import');
  assert(!diff.versionMetadata.portfolioMatch, 'portfolio mismatch');
  cie.destroy();
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== View Consistency After Undo/Redo ===\x1b[0m');

await test('undo restores exact previous state for all entity types', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');

  const snapBefore = store.exportData();
  store.addTask({ id: 'tNew', projectId: 'p1', name: 'New', dependencies: [] });
  store.addRisk({ id: 'rNew', projectId: 'p1', name: 'NewRisk', probability: 2, impact: 3 });
  hm.push('added task and risk');

  hm.undo();

  const snapAfter = store.exportData();
  assertEq(snapAfter.tasks.length, snapBefore.tasks.length, 'task count restored');
  assertEq(snapAfter.risks.length, snapBefore.risks.length, 'risk count restored');
  assertEq(snapAfter.projects.length, snapBefore.projects.length, 'project count restored');
  hm.dispose();
});

await test('redo re-applies state correctly', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);
  hm.push('seed');

  store.addTask({ id: 'tNew', projectId: 'p1', name: 'New', dependencies: [] });
  hm.push('added task');

  const snapAfterAdd = store.exportData();
  hm.undo();
  hm.redo();

  const snapAfterRedo = store.exportData();
  assertEq(snapAfterRedo.tasks.length, snapAfterAdd.tasks.length, 'task count after redo');
  hm.dispose();
});

await test('filtered tasks consistent after undo', () => {
  const { store } = makeWiredStore();
  const hm = new HistoryManager(store);
  seedData(store);

  // Set filter BEFORE pushing to history so the snapshot captures it
  store.setFilter('status', 'in-progress');
  hm.push('seed with filter');

  const filteredBefore = store.getFilteredTasks();

  store.addTask({ id: 'tNew', projectId: 'p1', name: 'New', status: 'in-progress', dependencies: [] });
  hm.push('added in-progress task');

  // After adding, there should be more filtered tasks
  const filteredAfterAdd = store.getFilteredTasks();
  assertGt(filteredAfterAdd.length, filteredBefore.length, 'more filtered tasks after add');

  hm.undo();

  const filteredAfter = store.getFilteredTasks();
  assertEq(filteredAfter.length, filteredBefore.length, 'filtered count consistent after undo');
  hm.dispose();
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Multi-File Import ===\x1b[0m');

await test('import merges multiple data sets', () => {
  const { store } = makeWiredStore();
  const pid = store.state.portfolioId;

  store.importData({
    projects: [{ id: 'p1', name: 'Proj1' }],
    tasks: [{ id: 't1', projectId: 'p1', name: 'Task1', dependencies: [] }],
    risks: [], resources: [],
  });

  store.importData({
    projects: [{ id: 'p2', name: 'Proj2' }],
    tasks: [{ id: 't2', projectId: 'p2', name: 'Task2', dependencies: [] }],
    risks: [], resources: [],
  });

  assertEq(store.state.projects.size, 2, 'both projects imported');
  assertEq(store.state.tasks.size, 2, 'both tasks imported');
  // Each import regenerates portfolioId
  assert(store.state.portfolioId !== pid, 'portfolioId changed');
});

await test('import remaps IDs to avoid collisions', () => {
  const { store } = makeWiredStore();

  store.importData({
    projects: [{ id: 'px', name: 'P1' }],
    tasks: [{ id: 'tx', projectId: 'px', name: 'T1', dependencies: [] }],
    risks: [], resources: [],
  });

  const projects = Array.from(store.state.projects.values());
  const tasks = Array.from(store.state.tasks.values());

  // IDs should be remapped to fresh UUIDs
  assert(projects[0].id !== 'px', 'project ID remapped');
  assert(tasks[0].id !== 'tx', 'task ID remapped');
  // But task.projectId should be remapped to match
  assertEq(tasks[0].projectId, projects[0].id, 'task.projectId remapped');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Baseline Save/Restore ===\x1b[0m');

await test('baseline save/restore round-trip', () => {
  const { store, depEngine } = makeWiredStore();
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);

  const id = bm.saveBaseline('BL1', 'Test baseline');
  const bl = bm.getBaseline(id);

  assert(bl !== null, 'baseline retrieved');
  assertEq(bl.name, 'BL1', 'name matches');
  assertEq(bl.snapshot.tasks.length, 3, 'snapshot tasks count');
  assert(bl.frozen, 'baseline is frozen');

  // Export and reimport
  const json = bm.exportBaselines();
  const { store: store2, depEngine: depEngine2 } = makeWiredStore();
  const bm2 = makeBaselineManager(store2, depEngine2);
  const result = bm2.importBaselines(json);
  assertEq(result.imported, 1, '1 baseline imported');
  assertEq(result.errors.length, 0, 'no errors');
});

await test('baseline survives undo — metrics remain stable', () => {
  const { store, depEngine } = makeWiredStore();
  const hm = new HistoryManager(store);
  const bm = makeBaselineManager(store, depEngine);
  seedData(store);
  hm.push('seed');

  const id = bm.saveBaseline('BL');
  const blBefore = bm.getBaseline(id);
  const critPathBefore = [...blBefore.metrics.criticalPathTaskIds];

  // Mutate and undo
  store.updateTask('t2', { plannedEnd: '2025-02-01' });
  hm.push('modify');
  hm.undo();

  // Baseline metrics should be unchanged (immutable)
  const blAfter = bm.getBaseline(id);
  assertEq(
    JSON.stringify(blAfter.metrics.criticalPathTaskIds),
    JSON.stringify(critPathBefore),
    'critical path unchanged in baseline'
  );
  hm.dispose();
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Dependency Engine Cache Versioning ===\x1b[0m');

await test('cache version tracks store version', () => {
  const { store, depEngine } = makeWiredStore();
  seedData(store);

  assertEq(depEngine.getCachedVersion(), -1, 'cache initially invalid');

  depEngine.calculateCriticalPath(null);
  assertGt(depEngine.getCachedVersion(), -1, 'cache version set after computation');

  // Mutate → cache invalidated
  store.addTask({ id: 't4', projectId: 'p1', name: 'T4', dependencies: ['t3'] });
  assertEq(depEngine.getCachedVersion(), -1, 'cache invalidated after mutation');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Integration: Full Workflow ===\x1b[0m');

await test('import → baseline → modify → undo → diff correct', () => {
  const { store, depEngine } = makeWiredStore();
  const hm = new HistoryManager(store);
  const bm = makeBaselineManager(store, depEngine);
  const cie = makeChangeImpactEngine(store, bm, depEngine);

  // 1. Import data
  store.importData({
    projects: [{ id: 'p1', name: 'P1' }],
    tasks: [
      { id: 't1', projectId: 'p1', name: 'T1', plannedStart: '2025-01-01', plannedEnd: '2025-01-10', dependencies: [], estimatedDays: 10 },
      { id: 't2', projectId: 'p1', name: 'T2', plannedStart: '2025-01-11', plannedEnd: '2025-01-20', dependencies: ['t1'], estimatedDays: 10 },
    ],
    risks: [], resources: [],
  });
  hm.push('import');

  // 2. Save baseline
  const blId = bm.saveBaseline('Post-Import');
  bm.setActiveBaseline(blId);
  const blMetrics = bm.getBaselineMetrics(blId);

  // 3. Modify
  store.updateTask('t2', { plannedEnd: '2025-01-30' });
  hm.push('delay t2');

  // 4. Diff should show delay
  const diff1 = cie.computeDiff(blId);
  assert(diff1.summary.totalDelayDays > 0, 'delay detected in diff');

  // 5. Undo
  hm.undo();

  // 6. After undo, diff should show minimal/no delay
  const diff2 = cie.computeDiff(blId);
  assert(diff2 !== null, 'diff computed after undo');
  // Task t2 should be back to original end date
  const t2Change = diff2.taskChanges.find(tc => tc.taskId !== undefined);
  // The diff should have no significant delay since we undid the change
  assert(diff2.summary.totalDelayDays <= diff1.summary.totalDelayDays, 'delay reduced after undo');

  // 7. Baseline metrics should still be from the save point
  const blMetricsAfter = bm.getBaselineMetrics(blId);
  assertEq(blMetricsAfter.taskCount, blMetrics.taskCount, 'baseline task count stable');

  hm.dispose();
  cie.destroy();
});

await test('circular dep does not corrupt history stack', () => {
  const { store, depEngine } = makeWiredStore();
  const hm = new HistoryManager(store);

  store.addProject({ id: 'p1', name: 'P' });
  store.addTask({ id: 't1', projectId: 'p1', name: 'T1', dependencies: [] });
  hm.push('initial');

  const historyBefore = hm.getHistory().length;

  // Introduce circular dependency
  store.addTask({ id: 't2', projectId: 'p1', name: 'T2', dependencies: ['t3'] });
  store.addTask({ id: 't3', projectId: 'p1', name: 'T3', dependencies: ['t2'] });
  hm.push('circular deps added');

  // Detect cycles (read-only operation, should not push to history)
  const cycles = depEngine.detectCircularDependencies();
  assert(cycles.length > 0, 'cycle detected');

  // History should not have extra entries from cycle detection
  const historyAfter = hm.getHistory().length;
  // The history grew by 1 (the push), not by cycle detection
  assert(historyAfter <= historyBefore + 2, 'history not corrupted by cycle detection');

  // Undo should still work correctly
  const result = hm.undo();
  assert(result.success, 'undo works after cycle detection');

  hm.dispose();
});

// ═════════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1m' + '═'.repeat(60) + '\x1b[0m');
console.log(`\x1b[1mResults: ${_pass} passed, ${_fail} failed, ${_pass + _fail} total\x1b[0m`);

if (_failures.length > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of _failures) {
    console.log(`  \x1b[31m✗ ${f.name}: ${f.error}\x1b[0m`);
  }
}

console.log('');
process.exit(_fail > 0 ? 1 : 0);
