// Validation Engine — Centralised validation aggregator that surfaces
// circular dependencies, cross-project dependency issues, resource duplicate
// allocations, baseline integrity checks, and multi-file import validation.

/* -------------------------------------------------------------------------- */
/*  Utility                                                                    */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  try { return structuredClone(obj); } catch (_) { /* fallback */ }
  return JSON.parse(JSON.stringify(obj));
}

/* -------------------------------------------------------------------------- */
/*  ValidationEngine                                                           */
/* -------------------------------------------------------------------------- */

export class ValidationEngine {
  /**
   * @param {import('../core/store.js').Store} store
   * @param {Object} deps
   * @param {import('../core/dependency-engine.js').DependencyEngine} deps.dependencyEngine
   * @param {import('../engine/resource-engine.js').ResourceEngine}   deps.resourceEngine
   * @param {import('../core/baseline-manager.js').BaselineManager}   deps.baselineManager
   */
  constructor(store, deps) {
    this._store = store;
    this._depEngine = deps.dependencyEngine;
    this._resEngine = deps.resourceEngine;
    this._baselineManager = deps.baselineManager;
  }

  /**
   * Run all validators and return merged, severity-sorted issues.
   * @returns {ValidationIssue[]}
   */
  validateAll() {
    const issues = [
      ...this.validateCircularDeps(),
      ...this.validateCrossProjectDeps(),
      ...this.validateResourceAllocations(),
    ];

    // Sort: errors first, then warnings, then info
    const severityOrder = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    return issues;
  }

  // -------------------------------------------------------------------------
  // Circular Dependencies
  // -------------------------------------------------------------------------

  /**
   * Wraps dependencyEngine.detectCircularDependencies() for UI surfacing.
   * @returns {ValidationIssue[]}
   */
  validateCircularDeps() {
    const issues = [];
    try {
      const cycles = this._depEngine.detectCircularDependencies();
      for (const cycle of cycles) {
        issues.push({
          severity: 'error',
          type: 'circular-dep',
          message: cycle.description || `Circular dependency detected involving ${cycle.cycle.length} tasks`,
          affectedIds: cycle.cycle || [],
          details: { cycle: cycle.cycle },
        });
      }
    } catch (err) {
      issues.push({
        severity: 'error',
        type: 'circular-dep',
        message: 'Error checking circular dependencies: ' + (err.message || String(err)),
        affectedIds: [],
      });
    }
    return issues;
  }

  // -------------------------------------------------------------------------
  // Cross-Project Dependencies
  // -------------------------------------------------------------------------

  /**
   * Validate cross-project dependency references.
   * @returns {ValidationIssue[]}
   */
  validateCrossProjectDeps() {
    const issues = [];
    const allTasks = Array.from(this._store.state.tasks.values());
    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    for (const task of allTasks) {
      if (!task.crossProjectDeps || task.crossProjectDeps.length === 0) continue;

      for (const cpd of task.crossProjectDeps) {
        // Check target task exists
        const target = taskMap.get(cpd.taskId);
        if (!target) {
          issues.push({
            severity: 'warning',
            type: 'dangling-cross-ref',
            message: `Task "${task.name}" has cross-project dependency to non-existent task "${cpd.taskId}"`,
            affectedIds: [task.id],
            details: { missingTaskId: cpd.taskId, projectId: cpd.projectId },
          });
          continue;
        }

        // Check source and target are in different projects
        if (task.projectId && target.projectId && task.projectId === target.projectId) {
          issues.push({
            severity: 'info',
            type: 'same-project-cross-ref',
            message: `Task "${task.name}" has cross-project dependency to "${target.name}" in the same project — consider using regular dependency`,
            affectedIds: [task.id, target.id],
          });
        }
      }
    }

    // Check for cross-project cycles using project-level DFS
    const projectCycleIssues = this._checkCrossProjectCycles(allTasks, taskMap);
    issues.push(...projectCycleIssues);

    return issues;
  }

  /** Check for cycles in the project dependency graph */
  _checkCrossProjectCycles(allTasks, taskMap) {
    const issues = [];

    // Build project-level adjacency graph
    const projectAdj = new Map();
    for (const task of allTasks) {
      if (!task.projectId) continue;
      if (!projectAdj.has(task.projectId)) projectAdj.set(task.projectId, new Set());

      for (const cpd of (task.crossProjectDeps || [])) {
        const target = taskMap.get(cpd.taskId);
        if (target && target.projectId && target.projectId !== task.projectId) {
          projectAdj.get(task.projectId).add(target.projectId);
        }
      }
    }

    // DFS cycle detection on project graph
    const color = new Map();
    for (const pid of projectAdj.keys()) color.set(pid, 0); // white

    const dfs = (nodeId, path) => {
      color.set(nodeId, 1); // gray
      path.push(nodeId);

      for (const next of (projectAdj.get(nodeId) || [])) {
        if (color.get(next) === 1) {
          const cycleStart = path.indexOf(next);
          const cycle = path.slice(cycleStart);
          issues.push({
            severity: 'error',
            type: 'cross-proj-cycle',
            message: `Cross-project dependency cycle: ${cycle.join(' → ')} → ${next}`,
            affectedIds: [],
            details: { cycle },
          });
        } else if (color.get(next) === 0) {
          dfs(next, path);
        }
      }

      path.pop();
      color.set(nodeId, 2); // black
    };

    for (const pid of projectAdj.keys()) {
      if (color.get(pid) === 0) dfs(pid, []);
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // Resource Allocations
  // -------------------------------------------------------------------------

  /**
   * Detect duplicate resource allocations (same resource assigned to same task twice).
   * @returns {ValidationIssue[]}
   */
  validateResourceAllocations() {
    const issues = [];
    const allResources = Array.from(this._store.state.resources.values());

    for (const resource of allResources) {
      if (!resource.tasks || resource.tasks.length === 0) continue;

      const seen = new Map(); // taskId → count
      for (const assignment of resource.tasks) {
        const count = (seen.get(assignment.taskId) || 0) + 1;
        seen.set(assignment.taskId, count);
      }

      for (const [taskId, count] of seen) {
        if (count > 1) {
          const task = this._store.state.tasks.get(taskId);
          issues.push({
            severity: 'warning',
            type: 'duplicate-allocation',
            message: `Resource "${resource.name}" is assigned to task "${task?.name || taskId}" ${count} times`,
            affectedIds: [resource.id, taskId],
            details: { resourceId: resource.id, taskId, count },
          });
        }
      }
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // Baseline Integrity
  // -------------------------------------------------------------------------

  /**
   * Check structural integrity of a specific baseline.
   * @param {string} baselineId
   * @returns {ValidationIssue[]}
   */
  validateBaselineIntegrity(baselineId) {
    const issues = [];
    const bl = this._baselineManager.getBaseline(baselineId);

    if (!bl) {
      issues.push({
        severity: 'error',
        type: 'baseline-missing',
        message: `Baseline "${baselineId}" not found`,
        affectedIds: [],
      });
      return issues;
    }

    if (!bl.frozen) {
      issues.push({
        severity: 'warning',
        type: 'baseline-not-frozen',
        message: `Baseline "${bl.name}" is not frozen (may have been tampered with)`,
        affectedIds: [],
      });
    }

    if (!bl.snapshot) {
      issues.push({
        severity: 'error',
        type: 'baseline-corrupt',
        message: `Baseline "${bl.name}" has no snapshot`,
        affectedIds: [],
      });
      return issues;
    }

    // Check snapshot structure
    const requiredKeys = ['projects', 'tasks', 'risks', 'resources'];
    for (const key of requiredKeys) {
      if (!Array.isArray(bl.snapshot[key])) {
        issues.push({
          severity: 'error',
          type: 'baseline-corrupt',
          message: `Baseline "${bl.name}" snapshot missing "${key}" array`,
          affectedIds: [],
        });
      }
    }

    // Check metrics consistency
    if (bl.metrics) {
      const expectedTaskCount = (bl.snapshot.tasks || []).length;
      if (bl.metrics.taskCount !== undefined && bl.metrics.taskCount !== expectedTaskCount) {
        issues.push({
          severity: 'warning',
          type: 'baseline-metrics-mismatch',
          message: `Baseline "${bl.name}" metrics show ${bl.metrics.taskCount} tasks but snapshot has ${expectedTaskCount}`,
          affectedIds: [],
        });
      }
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // Multi-File Import Validation
  // -------------------------------------------------------------------------

  /**
   * Validate files before import. Parses each and checks for conflicts.
   * @param {File[]} files
   * @returns {Promise<ValidationIssue[]>}
   */
  async validateMultiFileImport(files) {
    const issues = [];
    const parsedData = [];

    // Parse each file
    for (const file of files) {
      try {
        const text = await file.text();
        const data = this._parseImportCSV(text);
        if (data) {
          parsedData.push({ file: file.name, data });
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          type: 'import-parse-error',
          message: `Failed to parse "${file.name}": ${err.message || String(err)}`,
          affectedIds: [],
        });
      }
    }

    if (issues.some(i => i.severity === 'error')) return issues;

    // Check for project name collisions across files
    const projectNames = new Map();
    for (const { file, data } of parsedData) {
      for (const proj of (data.projects || [])) {
        const name = proj.name || '';
        if (projectNames.has(name)) {
          issues.push({
            severity: 'warning',
            type: 'import-conflict',
            message: `Project "${name}" defined in both "${projectNames.get(name)}" and "${file}"`,
            affectedIds: [],
            details: { projectName: name, files: [projectNames.get(name), file] },
          });
        } else {
          projectNames.set(name, file);
        }
      }
    }

    // Check for would-introduce circular dependencies
    const existingTasks = Array.from(this._store.state.tasks.values());
    const allImportedTasks = [];
    for (const { data } of parsedData) {
      allImportedTasks.push(...(data.tasks || []));
    }

    // Merge existing + imported and check cycles
    const mergedTaskIds = new Set([
      ...existingTasks.map(t => t.id),
      ...allImportedTasks.map(t => t.id),
    ]);

    // Simple cycle check: any imported task that creates a self-reference
    for (const task of allImportedTasks) {
      if ((task.dependencies || []).includes(task.id)) {
        issues.push({
          severity: 'error',
          type: 'import-cycle',
          message: `Imported task "${task.name}" has self-referencing dependency`,
          affectedIds: [task.id],
        });
      }
    }

    // Check for duplicate resource assignments across files
    const resourceTaskPairs = new Set();
    for (const { data } of parsedData) {
      for (const res of (data.resources || [])) {
        for (const assignment of (res.tasks || [])) {
          const key = `${res.id || res.name}:${assignment.taskId}`;
          if (resourceTaskPairs.has(key)) {
            issues.push({
              severity: 'warning',
              type: 'import-duplicate-allocation',
              message: `Resource "${res.name}" assigned to task "${assignment.taskId}" multiple times across import files`,
              affectedIds: [],
            });
          }
          resourceTaskPairs.add(key);
        }
      }
    }

    return issues;
  }

  /**
   * Simple CSV parser for import validation.
   * Returns { projects: [], tasks: [], risks: [], resources: [] }
   */
  _parseImportCSV(text) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;

    // Simple header parse
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));

    // Detect type from headers
    const taskKeywords = ['plannedstart', 'plannedend', 'progress', 'dependencies', 'assignee'];
    const riskKeywords = ['probability', 'impact', 'mitigation', 'category'];
    const resourceKeywords = ['maxcapacity', 'allocation', 'department', 'role'];

    const headerStr = headers.join(' ');
    let type = 'tasks';
    if (riskKeywords.some(k => headerStr.includes(k))) type = 'risks';
    else if (resourceKeywords.some(k => headerStr.includes(k))) type = 'resources';
    else if (!taskKeywords.some(k => headerStr.includes(k)) && headerStr.includes('projectmanager')) type = 'projects';

    // Parse rows (very basic — just extract names for collision checking)
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      const row = {};
      headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
      rows.push(row);
    }

    return { [type]: rows };
  }
}
