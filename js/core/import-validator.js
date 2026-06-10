/**
 * import-validator.js
 * Validates data integrity for CSV imports, baseline restores, and
 * multi-file merges.
 *
 * Checks for circular dependencies, cross-project dependency integrity,
 * resource duplicate allocations, dangling references, and ID collisions.
 */

// ---------------------------------------------------------------------------
// ImportValidator
// ---------------------------------------------------------------------------

export class ImportValidator {
  /**
   * @param {import('./store.js').Store} store
   * @param {import('./dependency-engine.js').DependencyEngine} dependencyEngine
   */
  constructor(store, dependencyEngine) {
    this._store = store;
    this._depEngine = dependencyEngine;
  }

  // -----------------------------------------------------------------------
  // Multi-file import validation
  // -----------------------------------------------------------------------

  /**
   * Validate one or more parsed data sets before importing.
   * Checks the merged dataset for integrity issues.
   * @param {Array<{projects?, tasks?, risks?, resources?}>} parsedDataArray
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateImport(parsedDataArray) {
    const errors = [];
    const warnings = [];

    // Merge all data into combined sets
    const allProjects = [];
    const allTasks = [];
    const allRisks = [];
    const allResources = [];

    for (const data of parsedDataArray) {
      if (data.projects) allProjects.push(...(Array.isArray(data.projects) ? data.projects : Object.values(data.projects)));
      if (data.tasks) allTasks.push(...(Array.isArray(data.tasks) ? data.tasks : Object.values(data.tasks)));
      if (data.risks) allRisks.push(...(Array.isArray(data.risks) ? data.risks : Object.values(data.risks)));
      if (data.resources) allResources.push(...(Array.isArray(data.resources) ? data.resources : Object.values(data.resources)));
    }

    // Also include existing store data for cross-reference validation
    const existingProjects = Array.from(this._store.state.projects.values());
    const existingTasks = Array.from(this._store.state.tasks.values());

    const mergedProjects = [...existingProjects, ...allProjects];
    const mergedTasks = [...existingTasks, ...allTasks];
    const mergedResources = [...Array.from(this._store.state.resources.values()), ...allResources];

    // 1. Check ID collisions across imported files
    const idCollisions = this._checkIdCollisions(parsedDataArray);
    errors.push(...idCollisions);

    // 2. Check circular dependencies
    const cycles = this._checkCircularDeps(mergedTasks);
    if (cycles.length > 0) {
      warnings.push(...cycles.map(c => `Circular dependency detected: ${c.join(' -> ')}`));
    }

    // 3. Check cross-project dependencies
    const crossErrors = this._checkCrossProjectDeps(allTasks, mergedProjects, mergedTasks);
    warnings.push(...crossErrors);

    // 4. Check resource duplicates
    const resDups = this._checkResourceDuplicates(mergedResources);
    warnings.push(...resDups);

    // 5. Check dangling references in imported data
    const danglingErrors = this._checkDanglingRefs({
      projects: allProjects,
      tasks: allTasks,
      risks: allRisks,
      resources: allResources,
    }, mergedProjects, mergedTasks);
    warnings.push(...danglingErrors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // -----------------------------------------------------------------------
  // Baseline restore validation
  // -----------------------------------------------------------------------

  /**
   * Validate a baseline snapshot before restoring.
   * @param {{projects, tasks, risks, resources}} snapshot
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateBaselineRestore(snapshot) {
    const errors = [];
    const warnings = [];

    if (!snapshot) {
      errors.push('Baseline snapshot is empty');
      return { valid: false, errors, warnings };
    }

    const projects = snapshot.projects || [];
    const tasks = snapshot.tasks || [];
    const risks = snapshot.risks || [];
    const resources = snapshot.resources || [];

    const projectIds = new Set(projects.map(p => p.id));
    const taskIds = new Set(tasks.map(t => t.id));

    // Check task -> project references
    for (const t of tasks) {
      if (t.projectId && !projectIds.has(t.projectId)) {
        warnings.push(`Task "${t.name}" references missing project ${t.projectId}`);
      }
    }

    // Check task dependencies
    for (const t of tasks) {
      for (const depId of (t.dependencies || [])) {
        if (!taskIds.has(depId)) {
          warnings.push(`Task "${t.name}" depends on missing task ${depId}`);
        }
      }
      for (const cpd of (t.crossProjectDeps || [])) {
        if (!taskIds.has(cpd.taskId)) {
          warnings.push(`Task "${t.name}" has cross-project dep on missing task ${cpd.taskId}`);
        }
      }
    }

    // Check risk references
    for (const r of risks) {
      if (r.projectId && !projectIds.has(r.projectId)) {
        warnings.push(`Risk "${r.name}" references missing project ${r.projectId}`);
      }
      if (r.taskId && !taskIds.has(r.taskId)) {
        warnings.push(`Risk "${r.name}" references missing task ${r.taskId}`);
      }
    }

    // Check resource -> task references
    for (const res of resources) {
      for (const rt of (res.tasks || [])) {
        if (!taskIds.has(rt.taskId)) {
          warnings.push(`Resource "${res.name}" assigned to missing task ${rt.taskId}`);
        }
      }
    }

    // Check circular dependencies
    const cycles = this._checkCircularDeps(tasks);
    if (cycles.length > 0) {
      warnings.push(...cycles.map(c => `Baseline contains circular dependency: ${c.join(' -> ')}`));
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // -----------------------------------------------------------------------
  // Individual validators
  // -----------------------------------------------------------------------

  /**
   * Check for ID collisions across multiple import files.
   * @param {Array<{projects?, tasks?, risks?, resources?}>} parsedDataArray
   * @returns {string[]} errors
   */
  _checkIdCollisions(parsedDataArray) {
    const errors = [];
    const seenIds = new Map(); // id -> file index

    for (let i = 0; i < parsedDataArray.length; i++) {
      const data = parsedDataArray[i];
      const entities = [
        ...(data.projects || []),
        ...(data.tasks || []),
        ...(data.risks || []),
        ...(data.resources || []),
      ];

      for (const entity of entities) {
        if (!entity.id) continue;
        if (seenIds.has(entity.id)) {
          const prevFile = seenIds.get(entity.id);
          if (prevFile !== i) {
            errors.push(`ID collision: "${entity.id}" appears in file ${prevFile + 1} and file ${i + 1}`);
          }
        } else {
          seenIds.set(entity.id, i);
        }
      }
    }

    return errors;
  }

  /**
   * Detect circular dependencies using DFS tri-color marking.
   * @param {Array<{id, dependencies?, crossProjectDeps?}>} tasks
   * @returns {string[][]} array of cycles (each cycle is an array of task ids)
   */
  _checkCircularDeps(tasks) {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const cycles = [];

    for (const t of tasks) color.set(t.id, WHITE);

    const dfs = (nodeId, path) => {
      color.set(nodeId, GRAY);
      path.push(nodeId);

      const node = taskMap.get(nodeId);
      if (!node) { color.set(nodeId, BLACK); path.pop(); return; }

      const deps = (node.dependencies || []).concat(
        (node.crossProjectDeps || []).map(d => d.taskId)
      );

      for (const depId of deps) {
        if (!taskMap.has(depId)) continue;
        const depColor = color.get(depId);
        if (depColor === GRAY) {
          // Found a cycle: extract the cycle from path
          const cycleStart = path.indexOf(depId);
          if (cycleStart !== -1) {
            cycles.push([...path.slice(cycleStart), depId]);
          }
        } else if (depColor === WHITE) {
          dfs(depId, path);
        }
      }

      color.set(nodeId, BLACK);
      path.pop();
    };

    for (const t of tasks) {
      if (color.get(t.id) === WHITE) {
        dfs(t.id, []);
      }
    }

    return cycles;
  }

  /**
   * Check cross-project dependency integrity.
   * @param {Array} importedTasks - newly imported tasks
   * @param {Array} allProjects - merged project list
   * @param {Array} allTasks - merged task list
   * @returns {string[]} warnings
   */
  _checkCrossProjectDeps(importedTasks, allProjects, allTasks) {
    const warnings = [];
    const projectIds = new Set(allProjects.map(p => p.id));
    const taskIds = new Set(allTasks.map(t => t.id));

    for (const t of importedTasks) {
      for (const cpd of (t.crossProjectDeps || [])) {
        if (cpd.projectId && !projectIds.has(cpd.projectId)) {
          warnings.push(`Task "${t.name}": cross-project dep references unknown project ${cpd.projectId}`);
        }
        if (cpd.taskId && !taskIds.has(cpd.taskId)) {
          warnings.push(`Task "${t.name}": cross-project dep references unknown task ${cpd.taskId}`);
        }
      }
    }

    return warnings;
  }

  /**
   * Check for resource duplicate allocations.
   * - Same taskId appearing multiple times in one resource's task list
   * - Same person (by name) having multiple resource entries
   * @param {Array} resources
   * @returns {string[]} warnings
   */
  _checkResourceDuplicates(resources) {
    const warnings = [];

    // Check duplicate task assignments within a single resource
    for (const r of resources) {
      const taskIds = new Set();
      for (const rt of (r.tasks || [])) {
        if (taskIds.has(rt.taskId)) {
          warnings.push(`Resource "${r.name}": task ${rt.taskId} is assigned multiple times`);
        }
        taskIds.add(rt.taskId);
      }
    }

    // Check duplicate resource names (possible data quality issue)
    const nameCount = new Map();
    for (const r of resources) {
      const name = (r.name || '').trim().toLowerCase();
      if (!name) continue;
      nameCount.set(name, (nameCount.get(name) || 0) + 1);
    }
    for (const [name, count] of nameCount) {
      if (count > 1) {
        warnings.push(`Resource name "${name}" appears ${count} times — possible duplicate entries`);
      }
    }

    return warnings;
  }

  /**
   * Check for dangling references in imported data.
   * @param {{projects, tasks, risks, resources}} importedData
   * @param {Array} mergedProjects
   * @param {Array} mergedTasks
   * @returns {string[]} warnings
   */
  _checkDanglingRefs(importedData, mergedProjects, mergedTasks) {
    const warnings = [];
    const projectIds = new Set(mergedProjects.map(p => p.id));
    const taskIds = new Set(mergedTasks.map(t => t.id));

    // Task -> project
    for (const t of (importedData.tasks || [])) {
      if (t.projectId && !projectIds.has(t.projectId)) {
        warnings.push(`Task "${t.name}" references non-existent project "${t.projectId}"`);
      }
      // Task dependencies
      for (const depId of (t.dependencies || [])) {
        if (depId === t.id) {
          warnings.push(`Task "${t.name}" depends on itself`);
        } else if (!taskIds.has(depId)) {
          warnings.push(`Task "${t.name}" depends on non-existent task "${depId}"`);
        }
      }
    }

    // Risk -> project/task
    for (const r of (importedData.risks || [])) {
      if (r.projectId && !projectIds.has(r.projectId)) {
        warnings.push(`Risk "${r.name}" references non-existent project "${r.projectId}"`);
      }
      if (r.taskId && !taskIds.has(r.taskId)) {
        warnings.push(`Risk "${r.name}" references non-existent task "${r.taskId}"`);
      }
    }

    // Resource -> task
    for (const res of (importedData.resources || [])) {
      for (const rt of (res.tasks || [])) {
        if (!taskIds.has(rt.taskId)) {
          warnings.push(`Resource "${res.name}" assigned to non-existent task "${rt.taskId}"`);
        }
      }
    }

    return warnings;
  }
}
