/**
 * csv-parser.js
 * Robust CSV parser for portfolio management data import.
 *
 * Features:
 *  - RFC-4180-compliant quoted-field handling (escaped quotes, embedded newlines)
 *  - Auto-detection of delimiter (comma, semicolon, tab)
 *  - Multi-format date parsing (ISO, slash, day-first, Chinese)
 *  - Bilingual field mapping (Chinese + English column names)
 *  - Graceful handling of missing / empty fields
 */

// ---------------------------------------------------------------------------
// Field-name mapping tables
// ---------------------------------------------------------------------------

/** Maps normalised header names -> canonical Project property */
const PROJECT_FIELD_MAP = {
  // English
  project: 'name', projectname: 'name', name: 'name',
  department: 'department', dept: 'department',
  projectmanager: 'projectManager', pm: 'projectManager', manager: 'projectManager',
  status: 'status',
  startdate: 'startDate', start: 'startDate',
  enddate: 'endDate', end: 'endDate',
  color: 'color', colour: 'color',
  // Chinese
  '\u9879\u76ee\u540d\u79f0': 'name', '\u9879\u76ee\u540d': 'name',
  '\u90e8\u95e8': 'department',
  '\u9879\u76ee\u7ecf\u7406': 'projectManager', '\u8d1f\u8d23\u4eba': 'projectManager',
  '\u72b6\u6001': 'status',
  '\u5f00\u59cb\u65e5\u671f': 'startDate', '\u8ba1\u5212\u5f00\u59cb': 'startDate',
  '\u7ed3\u675f\u65e5\u671f': 'endDate', '\u8ba1\u5212\u7ed3\u675f': 'endDate',
  '\u989c\u8272': 'color',
};

/** Maps normalised header names -> canonical Task property */
const TASK_FIELD_MAP = {
  // English
  task: 'name', taskname: 'name', name: 'name',
  project: 'projectId', projectid: 'projectId', projectname: 'projectId',
  dependencies: 'dependencies', predecessors: 'dependencies', deps: 'dependencies',
  crossprojectdeps: 'crossProjectDeps',
  assignee: 'assignee', owner: 'assignee', responsible: 'assignee',
  plannedstart: 'plannedStart', startdate: 'plannedStart', start: 'plannedStart',
  plannedend: 'plannedEnd', enddate: 'plannedEnd', end: 'plannedEnd',
  actualstart: 'actualStart',
  actualend: 'actualEnd',
  status: 'status',
  progress: 'progress', completion: 'progress', percent: 'progress',
  milestone: 'isMilestone', ismilestone: 'isMilestone', milestonedate: 'milestoneDate',
  estimateddays: 'estimatedDays', estimate: 'estimatedDays', duration: 'estimatedDays',
  priority: 'priority',
  // Chinese
  '\u4efb\u52a1\u540d\u79f0': 'name', '\u4efb\u52a1\u540d': 'name', '\u4efb\u52a1': 'name',
  '\u6240\u5c5e\u9879\u76ee': 'projectId', '\u9879\u76ee': 'projectId',
  '\u4f9d\u8d56': 'dependencies', '\u524d\u7f6e\u4efb\u52a1': 'dependencies',
  '\u8d1f\u8d23\u4eba': 'assignee', '\u6267\u884c\u4eba': 'assignee',
  '\u8ba1\u5212\u5f00\u59cb': 'plannedStart', '\u5f00\u59cb\u65e5\u671f': 'plannedStart',
  '\u8ba1\u5212\u7ed3\u675f': 'plannedEnd', '\u7ed3\u675f\u65e5\u671f': 'plannedEnd',
  '\u5b9e\u9645\u5f00\u59cb': 'actualStart',
  '\u5b9e\u9645\u7ed3\u675f': 'actualEnd',
  '\u72b6\u6001': 'status',
  '\u8fdb\u5ea6': 'progress', '\u5b8c\u6210\u5ea6': 'progress',
  '\u91cc\u7a0b\u7891': 'isMilestone', '\u91cc\u7a0b\u7891\u65e5\u671f': 'milestoneDate',
  '\u9884\u4f30\u5929\u6570': 'estimatedDays', '\u5de5\u671f': 'estimatedDays',
  '\u4f18\u5148\u7ea7': 'priority',
};

/** Maps normalised header names -> canonical Risk property */
const RISK_FIELD_MAP = {
  // English
  riskname: 'name', risk: 'name', name: 'name',
  projectid: 'projectId', project: 'projectId',
  taskid: 'taskId', task: 'taskId',
  probability: 'probability', prob: 'probability', likelihood: 'probability',
  impact: 'impact', severity: 'impact',
  level: 'level', risklevel: 'level',
  category: 'category', type: 'category',
  mitigation: 'mitigation', response: 'mitigation', action: 'mitigation',
  status: 'status',
  owner: 'owner', riskowner: 'owner',
  // Chinese
  '\u98ce\u9669\u540d\u79f0': 'name', '\u98ce\u9669': 'name',
  '\u6240\u5c5e\u9879\u76ee': 'projectId', '\u9879\u76ee': 'projectId',
  '\u5173\u8054\u4efb\u52a1': 'taskId', '\u4efb\u52a1': 'taskId',
  '\u6982\u7387': 'probability', '\u53ef\u80fd\u6027': 'probability',
  '\u5f71\u54cd': 'impact', '\u5f71\u54cd\u7a0b\u5ea6': 'impact',
  '\u98ce\u9669\u7b49\u7ea7': 'level', '\u7b49\u7ea7': 'level',
  '\u7c7b\u522b': 'category', '\u98ce\u9669\u7c7b\u522b': 'category',
  '\u5e94\u5bf9\u63aa\u65bd': 'mitigation', '\u7f13\u89e3\u63aa\u65bd': 'mitigation',
  '\u72b6\u6001': 'status',
  '\u8d23\u4efb\u4eba': 'owner', '\u98ce\u9669\u8d1f\u8d23\u4eba': 'owner',
};

/** Maps normalised header names -> canonical Resource property */
const RESOURCE_FIELD_MAP = {
  // English
  resource: 'name', resourcename: 'name', name: 'name',
  department: 'department', dept: 'department',
  role: 'role', title: 'role',
  taskid: 'taskId', task: 'taskId',
  projectid: 'projectId', project: 'projectId',
  allocation: 'allocation', effort: 'allocation',
  maxcapacity: 'maxCapacity', capacity: 'maxCapacity',
  // Chinese
  '\u8d44\u6e90': 'name', '\u8d44\u6e90\u540d\u79f0': 'name', '\u59d3\u540d': 'name',
  '\u90e8\u95e8': 'department',
  '\u89d2\u8272': 'role', '\u804c\u4f4d': 'role',
  '\u4efb\u52a1': 'taskId', '\u4efb\u52a1\u540d\u79f0': 'taskId',
  '\u9879\u76ee': 'projectId', '\u6240\u5c5e\u9879\u76ee': 'projectId',
  '\u6295\u5165': 'allocation', '\u6295\u5165\u6bd4': 'allocation', '\u5206\u914d': 'allocation',
  '\u6700\u5927\u4ea7\u80fd': 'maxCapacity', '\u4ea7\u80fd': 'maxCapacity',
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Named date-format tokens used in detectDateFormat / normaliseDate */
const DATE_FORMATS = {
  ISO: /^\d{4}-\d{1,2}-\d{1,2}$/,                     // YYYY-MM-DD
  SLASH: /^\d{4}\/\d{1,2}\/\d{1,2}$/,                 // YYYY/MM/DD
  DMY_SLASH: /^\d{1,2}\/\d{1,2}\/\d{4}$/,             // DD/MM/YYYY or MM/DD/YYYY
  DMY_DASH: /^\d{1,2}-\d{1,2}-\d{4}$/,                // DD-MM-YYYY
  CHINESE: /^\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5$/, // YYYY年MM月DD日
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Remove UTF-8 BOM if present */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Normalise a header cell for lookup: trim, lowercase, strip BOM */
function normalizeHeader(h) {
  return stripBom(h).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Parse a percentage string like "75%" or "0.75" into a number 0-100 */
function parsePercent(value) {
  if (value == null || value === '') return 0;
  const s = String(value).trim().replace('%', '');
  const n = Number(s);
  if (Number.isNaN(n)) return 0;
  // Treat values <= 1 as fraction (e.g. 0.75 -> 75)
  return n <= 1 && n >= 0 && s.includes('.') ? Math.round(n * 100) : Math.min(100, Math.max(0, n));
}

/** Parse a semicolon-or-comma separated list into an array of trimmed strings */
function parseList(value) {
  if (!value || value === '') return [];
  return String(value).split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

/** Parse a boolean-ish value */
function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return ['true', 'yes', '1', '\u662f', 'y'].includes(v);
}

/** Clamp a number between min and max */
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// CSVParser class
// ---------------------------------------------------------------------------

export class CSVParser {
  // -----------------------------------------------------------------------
  // Low-level CSV tokenisation
  // -----------------------------------------------------------------------

  /**
   * Detect the most likely delimiter in raw CSV text.
   * Candidates: comma, semicolon, tab.  We pick the character that produces
   * the most consistent column count across the first several lines.
   */
  static detectDelimiter(text) {
    const candidates = [',', ';', '\t'];
    const sample = text.split(/\r?\n/).slice(0, 10);

    let bestDelimiter = ',';
    let bestScore = -Infinity;

    for (const delim of candidates) {
      const counts = sample.map(line => CSVParser._splitRow(line, delim).length);
      const first = counts[0];
      if (first < 2) continue; // unlikely to be the right delimiter
      // Score = number of lines with the same column count as the first line
      const consistent = counts.filter(c => c === first).length;
      const score = consistent * first; // reward both consistency and width
      if (score > bestScore) {
        bestScore = score;
        bestDelimiter = delim;
      }
    }
    return bestDelimiter;
  }

  /**
   * Split a single CSV row respecting double-quoted fields.
   * Handles escaped quotes ("") within quoted regions.
   */
  static _splitRow(row, delimiter) {
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < row.length && row[i + 1] === '"') {
            current += '"';
            i++; // skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          cells.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    cells.push(current);
    return cells;
  }

  /**
   * Full parse of CSV text into an array-of-objects (first row = headers).
   * Correctly handles newlines embedded within quoted fields.
   */
  static _parseCSV(text, delimiter) {
    text = stripBom(text.trim());
    if (!text) return [];

    const rows = [];
    let current = '';
    let inQuotes = false;

    // Walk character-by-character to handle quoted newlines
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
            current += ch;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          current += ch;
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
          if (current.trim()) rows.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    if (current.trim()) rows.push(current);

    if (rows.length < 2) return []; // need header + at least one data row

    const headers = CSVParser._splitRow(rows[0], delimiter).map(h => h.trim());
    const records = [];

    for (let r = 1; r < rows.length; r++) {
      const cells = CSVParser._splitRow(rows[r], delimiter);
      const obj = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = (cells[c] ?? '').trim();
      }
      records.push(obj);
    }
    return records;
  }

  // -----------------------------------------------------------------------
  // Date handling
  // -----------------------------------------------------------------------

  /**
   * Detect the predominant date format in a block of text by sampling
   * date-like tokens and tallying which regex they match.
   */
  detectDateFormat(text) {
    const dateTokens = text.match(
      /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5/g
    );
    if (!dateTokens || dateTokens.length === 0) return 'ISO';

    const tallies = { ISO: 0, SLASH: 0, DMY_SLASH: 0, DMY_DASH: 0, CHINESE: 0 };
    for (const tok of dateTokens) {
      for (const [name, regex] of Object.entries(DATE_FORMATS)) {
        if (regex.test(tok)) { tallies[name]++; break; }
      }
    }

    let best = 'ISO';
    for (const [name, count] of Object.entries(tallies)) {
      if (count > tallies[best]) best = name;
    }
    return best;
  }

  /**
   * Normalise a date value from any supported format to a JS Date (or null).
   * Handles: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY,
   *          and Chinese YYYY年MM月DD日.
   *
   * Ambiguous dates (DD/MM vs MM/DD) are resolved by checking whether the
   * first segment > 12 (then it must be a day) -- otherwise MM/DD is assumed
   * (US convention) unless the detected format says otherwise.
   */
  normalizeDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const s = String(value).trim();
    if (!s) return null;

    let y, m, d;

    // Chinese format: YYYY年MM月DD日
    const chMatch = s.match(/^(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5$/);
    if (chMatch) {
      y = +chMatch[1]; m = +chMatch[2]; d = +chMatch[3];
      return this._safeDate(y, m, d);
    }

    // ISO: YYYY-MM-DD
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      y = +isoMatch[1]; m = +isoMatch[2]; d = +isoMatch[3];
      return this._safeDate(y, m, d);
    }

    // Slash year-first: YYYY/MM/DD
    const slashMatch = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (slashMatch) {
      y = +slashMatch[1]; m = +slashMatch[2]; d = +slashMatch[3];
      return this._safeDate(y, m, d);
    }

    // Dash day/month first: DD-MM-YYYY
    const dmyDash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dmyDash) {
      // If first number > 12 it must be day -> DD-MM-YYYY
      // Otherwise assume DD-MM-YYYY as specified
      const a = +dmyDash[1], b = +dmyDash[2];
      y = +dmyDash[3];
      if (a > 12) { d = a; m = b; }
      else { d = a; m = b; } // DD-MM-YYYY
      return this._safeDate(y, m, d);
    }

    // Slash day/month first: DD/MM/YYYY or MM/DD/YYYY
    const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmySlash) {
      const a = +dmySlash[1], b = +dmySlash[2];
      y = +dmySlash[3];
      if (a > 12) {
        // a must be day -> DD/MM/YYYY
        d = a; m = b;
      } else if (b > 12) {
        // b must be day -> MM/DD/YYYY
        m = a; d = b;
      } else {
        // Ambiguous -- default to DD/MM/YYYY
        d = a; m = b;
      }
      return this._safeDate(y, m, d);
    }

    // Fallback: try native Date.parse
    const fallback = new Date(s);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  /** Build a Date from numeric y/m/d, returning null for invalid combos */
  _safeDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // -----------------------------------------------------------------------
  // Field mapping helpers
  // -----------------------------------------------------------------------

  /**
   * Given a raw record (object keyed by original headers) and a field map,
   * return a new object with canonical property names.
   */
  _mapFields(record, fieldMap) {
    const mapped = {};
    for (const [rawKey, value] of Object.entries(record)) {
      const canon = fieldMap[normalizeHeader(rawKey)];
      if (canon) {
        mapped[canon] = value;
      }
    }
    return mapped;
  }

  /** Auto-detect type from header row by looking for distinctive columns */
  _detectType(headers) {
    const normed = headers.map(normalizeHeader);
    const has = (...keys) => keys.some(k => normed.some(h => h.includes(k)));

    if (has('probability', '\u6982\u7387', 'impact', '\u5f71\u54cd', 'risklevel', '\u98ce\u9669\u7b49\u7ea7')) return 'risks';
    if (has('allocation', '\u6295\u5165', 'maxcapacity', '\u4ea7\u80fd', 'role', '\u89d2\u8272')) return 'resources';
    if (has('dependencies', '\u4f9d\u8d56', 'progress', '\u8fdb\u5ea6', 'milestone', '\u91cc\u7a0b\u7891', 'predecessors')) return 'tasks';
    if (has('projectmanager', '\u9879\u76ee\u7ecf\u7406', 'department', '\u90e8\u95e8', 'color')) return 'projects';
    // Default to tasks since they are the most common import
    return 'tasks';
  }

  // -----------------------------------------------------------------------
  // Generate unique IDs
  // -----------------------------------------------------------------------

  _uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
  }

  // -----------------------------------------------------------------------
  // Public parse methods
  // -----------------------------------------------------------------------

  /**
   * Auto-detect type from headers and parse accordingly.
   * Returns an object with all four arrays (only the detected one populated).
   */
  parse(text, type) {
    const delimiter = CSVParser.detectDelimiter(text);
    const raw = CSVParser._parseCSV(text, delimiter);
    if (raw.length === 0) return { projects: [], tasks: [], risks: [], resources: [] };

    // Peek at headers for auto-detect when type not supplied
    if (!type) {
      const headerRow = Object.keys(raw[0]);
      type = this._detectType(headerRow);
    }

    switch (type) {
      case 'projects':  return { projects: this.parseProjects(text), tasks: [], risks: [], resources: [] };
      case 'tasks':     return { projects: [], tasks: this.parseTasks(text), risks: [], resources: [] };
      case 'risks':     return { projects: [], tasks: [], risks: this.parseRisks(text), resources: [] };
      case 'resources': return { projects: [], tasks: [], risks: [], resources: this.parseResources(text) };
      default:          return { projects: [], tasks: [], risks: [], resources: [] };
    }
  }

  /** Parse text as an array of Project records */
  parseProjects(text) {
    const delimiter = CSVParser.detectDelimiter(text);
    const records = CSVParser._parseCSV(text, delimiter);
    return records.map(r => {
      const m = this._mapFields(r, PROJECT_FIELD_MAP);
      return {
        id: m.id || this._uid(),
        name: m.name || 'Unnamed Project',
        department: m.department || '',
        projectManager: m.projectManager || '',
        status: m.status || 'active',
        startDate: this.normalizeDate(m.startDate)?.toISOString().slice(0, 10) || null,
        endDate: this.normalizeDate(m.endDate)?.toISOString().slice(0, 10) || null,
        color: m.color || '#4A90D9',
      };
    });
  }

  /** Parse text as an array of Task records */
  parseTasks(text) {
    const delimiter = CSVParser.detectDelimiter(text);
    const records = CSVParser._parseCSV(text, delimiter);
    return records.map(r => {
      const m = this._mapFields(r, TASK_FIELD_MAP);
      return {
        id: m.id || this._uid(),
        projectId: m.projectId || '',
        name: m.name || 'Unnamed Task',
        dependencies: Array.isArray(m.dependencies) ? m.dependencies : parseList(m.dependencies),
        crossProjectDeps: Array.isArray(m.crossProjectDeps) ? m.crossProjectDeps : [],
        assignee: m.assignee || '',
        plannedStart: this.normalizeDate(m.plannedStart)?.toISOString().slice(0, 10) || null,
        plannedEnd: this.normalizeDate(m.plannedEnd)?.toISOString().slice(0, 10) || null,
        actualStart: this.normalizeDate(m.actualStart)?.toISOString().slice(0, 10) || null,
        actualEnd: this.normalizeDate(m.actualEnd)?.toISOString().slice(0, 10) || null,
        status: m.status || 'not-started',
        progress: parsePercent(m.progress),
        isMilestone: parseBool(m.isMilestone),
        milestoneDate: this.normalizeDate(m.milestoneDate)?.toISOString().slice(0, 10) || null,
        estimatedDays: m.estimatedDays ? Number(m.estimatedDays) || 0 : 0,
        priority: m.priority ? clamp(Number(m.priority) || 1, 1, 5) : 3,
      };
    });
  }

  /** Parse text as an array of Risk records */
  parseRisks(text) {
    const delimiter = CSVParser.detectDelimiter(text);
    const records = CSVParser._parseCSV(text, delimiter);
    return records.map(r => {
      const m = this._mapFields(r, RISK_FIELD_MAP);
      const prob = clamp(Number(m.probability) || 3, 1, 5);
      const impact = clamp(Number(m.impact) || 3, 1, 5);
      // Auto-compute level from probability * impact if not explicitly provided
      const level = m.level || this._computeRiskLevel(prob, impact);
      return {
        id: m.id || this._uid(),
        projectId: m.projectId || '',
        taskId: m.taskId || '',
        name: m.name || 'Unnamed Risk',
        probability: prob,
        impact,
        level,
        category: m.category || 'general',
        mitigation: m.mitigation || '',
        status: m.status || 'open',
        owner: m.owner || '',
      };
    });
  }

  /** Parse text as an array of Resource records */
  parseResources(text) {
    const delimiter = CSVParser.detectDelimiter(text);
    const records = CSVParser._parseCSV(text, delimiter);
    return records.map(r => {
      const m = this._mapFields(r, RESOURCE_FIELD_MAP);
      const allocation = m.allocation ? clamp(Number(m.allocation) || 100, 0, 100) : 100;
      return {
        id: m.id || this._uid(),
        name: m.name || 'Unnamed Resource',
        department: m.department || '',
        role: m.role || '',
        tasks: m.taskId ? [{
          taskId: m.taskId,
          projectId: m.projectId || '',
          allocation,
        }] : [],
        maxCapacity: m.maxCapacity ? clamp(Number(m.maxCapacity) || 100, 0, 200) : 100,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Risk-level helper
  // -----------------------------------------------------------------------

  /** Compute a qualitative risk level from probability and impact (1-5 each) */
  _computeRiskLevel(probability, impact) {
    const score = probability * impact;
    if (score >= 20) return 'critical';
    if (score >= 12) return 'high';
    if (score >= 6)  return 'medium';
    return 'low';
  }

  /**
   * Export store state data to a combined CSV string.
   * @param {{ projects?: Array, tasks?: Array, risks?: Array, resources?: Array }} data
   * @returns {string} CSV text
   */
  static exportData(data) {
    const sections = [];

    if (data.projects && data.projects.length > 0) {
      const headers = ['name', 'department', 'projectManager', 'status', 'startDate', 'endDate', 'color'];
      const rows = data.projects.map(p => headers.map(h => CSVParser._csvEscape(p[h])).join(','));
      sections.push(['# Projects', headers.join(','), ...rows].join('\n'));
    }

    if (data.tasks && data.tasks.length > 0) {
      const headers = ['name', 'projectId', 'assignee', 'plannedStart', 'plannedEnd', 'status', 'progress', 'dependencies'];
      const rows = data.tasks.map(t => headers.map(h => {
        if (h === 'dependencies') return CSVParser._csvEscape((t.dependencies || []).join(';'));
        return CSVParser._csvEscape(t[h]);
      }).join(','));
      sections.push(['# Tasks', headers.join(','), ...rows].join('\n'));
    }

    if (data.risks && data.risks.length > 0) {
      const headers = ['name', 'projectId', 'taskId', 'probability', 'impact', 'level', 'category', 'mitigation', 'status', 'owner'];
      const rows = data.risks.map(r => headers.map(h => CSVParser._csvEscape(r[h])).join(','));
      sections.push(['# Risks', headers.join(','), ...rows].join('\n'));
    }

    if (data.resources && data.resources.length > 0) {
      const headers = ['name', 'department', 'role', 'maxCapacity'];
      const rows = data.resources.map(r => headers.map(h => CSVParser._csvEscape(r[h])).join(','));
      sections.push(['# Resources', headers.join(','), ...rows].join('\n'));
    }

    return sections.join('\n\n');
  }

  /** Escape a value for CSV output. */
  static _csvEscape(value) {
    const s = String(value ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // -----------------------------------------------------------------------
  // Sample CSV generation
  // -----------------------------------------------------------------------

  /**
   * Generate a sample CSV string for a given type, suitable for download
   * so users can see the expected format.
   */
  static generateSampleCSV(type) {
    switch (type) {
      case 'projects':
        return [
          'Project Name,Department,Project Manager,Status,Start Date,End Date,Color',
          'Website Redesign,Engineering,Alice Zhang,active,2026-01-15,2026-06-30,#4A90D9',
          'Mobile App,Product,Bob Lee,planning,2026-03-01,2026-09-15,#E67E22',
          'Data Migration,IT,Carol Wu,on-hold,2026-02-01,2026-05-31,#27AE60',
        ].join('\n');

      case 'tasks':
        return [
          'Task Name,Project,Assignee,Planned Start,Planned End,Dependencies,Status,Progress,Milestone,Priority',
          'Design mockups,Website Redesign,Alice,2026-01-15,2026-02-01,,in-progress,60%,No,4',
          'Frontend development,Website Redesign,Bob,2026-02-02,2026-04-15,Design mockups,not-started,0%,No,3',
          'Launch,Website Redesign,Alice,2026-06-30,2026-06-30,Frontend development,not-started,0%,Yes,5',
          'API design,Mobile App,Carol,2026-03-01,2026-03-20,,completed,100%,No,4',
          'UI implementation,Mobile App,Dave,2026-03-21,2026-06-01,API design,in-progress,30%,No,3',
        ].join('\n');

      case 'risks':
        return [
          'Risk Name,Project,Task,Probability,Impact,Level,Category,Mitigation,Status,Owner',
          'Scope creep,Website Redesign,,4,4,high,scope,Define requirements early,open,Alice',
          'API delay,Mobile App,API design,3,5,critical,technical,Add buffer time,mitigating,Carol',
          'Data loss,Data Migration,,2,5,high,operational,Full backup before migration,open,Bob',
        ].join('\n');

      case 'resources':
        return [
          'Resource Name,Department,Role,Task,Project,Allocation,Max Capacity',
          'Alice Zhang,Engineering,Designer,Design mockups,Website Redesign,80,100',
          'Bob Lee,Product,Developer,Frontend development,Website Redesign,100,100',
          'Carol Wu,IT,Architect,API design,Mobile App,60,100',
          'Dave Chen,Product,Developer,UI implementation,Mobile App,100,100',
        ].join('\n');

      default:
        return 'id,name\n1,Sample';
    }
  }
}
