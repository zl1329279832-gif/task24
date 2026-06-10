// FilterBar - Horizontal filter and search bar with dynamic dropdowns,
// active filter chips, text search, and result counts.
// Populates filter options from store.getFilterOptions().

const SEARCH_DEBOUNCE_MS = 300;

/**
 * FilterBar renders a horizontal bar with dropdown filters for Department,
 * Project Manager, Status, and Risk Level, plus a text search input and
 * active filter chips. All filter changes are pushed to the store.
 */
export class FilterBar {
  constructor(container, store) {
    this.container = container;
    this.store = store;

    this._listeners = [];
    this._unsubscribe = null;
    this._searchTimer = null;

    this._buildDOM();
    this._bindEvents();
    this._unsubscribe = this.store.subscribe(() => this.render());
  }

  render() {
    this._renderDropdowns();
    this._renderChips();
    this._renderResultCount();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._listeners.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    this.container.innerHTML = '';
  }

  // -- DOM ----------------------------------------------------------------

  _buildDOM() {
    this.container.classList.add('filter-root');
    this.container.innerHTML = `
      <div class="filter-bar">
        <div class="filter-dropdowns">
          <div class="filter-group" data-filter="department">
            <label class="filter-label">Department</label>
            <select class="filter-select filter-select--department"><option value="">All</option></select>
          </div>
          <div class="filter-group" data-filter="projectManager">
            <label class="filter-label">Manager</label>
            <select class="filter-select filter-select--manager"><option value="">All</option></select>
          </div>
          <div class="filter-group" data-filter="status">
            <label class="filter-label">Status</label>
            <select class="filter-select filter-select--status"><option value="">All</option></select>
          </div>
          <div class="filter-group" data-filter="riskLevel">
            <label class="filter-label">Risk Level</label>
            <select class="filter-select filter-select--risk"><option value="">All</option></select>
          </div>
        </div>
        <div class="filter-search">
          <input type="text" class="filter-search-input" placeholder="Search projects, tasks, assignees..." />
        </div>
        <div class="filter-actions">
          <button class="filter-btn filter-btn-reset">Reset All</button>
        </div>
      </div>
      <div class="filter-chips"></div>
      <div class="filter-count"></div>
    `;

    this._els = {
      department: this.container.querySelector('.filter-select--department'),
      manager: this.container.querySelector('.filter-select--manager'),
      status: this.container.querySelector('.filter-select--status'),
      risk: this.container.querySelector('.filter-select--risk'),
      search: this.container.querySelector('.filter-search-input'),
      resetBtn: this.container.querySelector('.filter-btn-reset'),
      chips: this.container.querySelector('.filter-chips'),
      count: this.container.querySelector('.filter-count'),
    };
  }

  _listen(el, evt, fn) {
    el.addEventListener(evt, fn);
    this._listeners.push([el, evt, fn]);
  }

  // -- Events --------------------------------------------------------------

  _bindEvents() {
    // Dropdown changes
    const onSelect = (key, el) => {
      this._listen(el, 'change', (e) => {
        this.store.setFilter(key, e.target.value || 'all');
      });
    };
    onSelect('department', this._els.department);
    onSelect('projectManager', this._els.manager);
    onSelect('status', this._els.status);
    onSelect('riskLevel', this._els.risk);

    // Debounced text search
    this._listen(this._els.search, 'input', (e) => {
      const val = e.target.value;
      if (this._searchTimer) clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.store.setFilter('search', val || '');
      }, SEARCH_DEBOUNCE_MS);
    });

    // Reset all
    this._listen(this._els.resetBtn, 'click', () => {
      this.store.resetFilters();
      this._els.search.value = '';
    });
  }

  // -- Dropdown population -------------------------------------------------

  _renderDropdowns() {
    let options;
    try {
      options = this.store.getFilterOptions();
    } catch {
      options = { departments: [], projectManagers: [], statuses: [], riskLevels: [] };
    }

    const filters = this.store.state.filters || {};

    this._populateSelect(this._els.department, options.departments || [], filters.department);
    this._populateSelect(this._els.manager, options.projectManagers || [], filters.projectManager);
    this._populateSelect(this._els.status, options.statuses || [], filters.status);
    this._populateSelect(this._els.risk, options.riskLevels || [], filters.riskLevel);
  }

  _populateSelect(select, values, selected) {
    // Preserve the first "All" option
    const firstOption = select.querySelector('option');
    select.innerHTML = '';
    select.appendChild(firstOption);

    for (const val of values) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      if (val === selected) opt.selected = true;
      select.appendChild(opt);
    }
  }

  // -- Active filter chips -------------------------------------------------

  _renderChips() {
    const filters = this.store.state.filters || {};
    const chips = [];

    const labelMap = {
      department: 'Department',
      projectManager: 'Manager',
      status: 'Status',
      riskLevel: 'Risk Level',
      search: 'Search',
    };

    for (const [key, value] of Object.entries(filters)) {
      if (!value || value === 'all') continue;
      const label = labelMap[key] || key;
      const chip = document.createElement('span');
      chip.className = 'filter-chip';
      chip.innerHTML = `${label}: ${value} <button class="filter-chip-remove" data-key="${key}">&times;</button>`;
      chips.push(chip);
    }

    this._els.chips.innerHTML = '';
    chips.forEach((chip) => {
      this._listen(chip.querySelector('.filter-chip-remove'), 'click', (e) => {
        const key = e.target.dataset.key;
        this.store.setFilter(key, 'all');
        if (key === 'search') this._els.search.value = '';
      });
      this._els.chips.appendChild(chip);
    });
  }

  // -- Result count --------------------------------------------------------

  _renderResultCount() {
    const projects = this.store.getFilteredProjects();
    const tasks = this.store.getFilteredTasks();
    const pCount = Array.isArray(projects) ? projects.length : (projects ? projects.size : 0);
    const tCount = Array.isArray(tasks) ? tasks.length : (tasks ? tasks.size : 0);
    this._els.count.textContent = `${pCount} projects, ${tCount} tasks`;
  }
}
