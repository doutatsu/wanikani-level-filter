// ==UserScript==
// @name         WaniKani Level Filter
// @namespace    wanikani-level-filter
// @description  Filter reviews by level during active review sessions
// @version      1.3.2
// @author       doutatsu
// @match        https://www.wanikani.com/*
// @match        https://preview.wanikani.com/*
// @require      https://greasyfork.org/scripts/462049-wanikani-queue-manipulator/code/WaniKani%20Queue%20Manipulator.user.js
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // ============================================
  // SECTION 1: CONSTANTS & CONFIGURATION
  // ============================================
  const STORAGE_KEY = 'wk-level-filter-selection';
  const SORT_STORAGE_KEY = 'wk-level-filter-sort-direction';
  const SORT_DESC = 'desc'; // Highest SRS stage first (default)
  const SORT_ASC = 'asc';   // Lowest SRS stage first
  const SORT_NONE = 'none'; // No sorting - keep the queue's original order
  // Toggle button label/tooltip per mode; tooltips describe the next click.
  // Declaration order doubles as the cycle order (see SORT_CYCLE below), so
  // every mode necessarily has a label.
  const SORT_LABELS = {
    [SORT_DESC]: {
      text: 'SRS ↓',
      title: 'Sorting by SRS: highest first (click for lowest first)'
    },
    [SORT_ASC]: {
      text: 'SRS ↑',
      title: 'Sorting by SRS: lowest first (click to disable sorting)'
    },
    [SORT_NONE]: {
      text: 'SRS —',
      title: 'No SRS sorting: original order (click for highest first)'
    }
  };
  // Order the toggle button cycles through on each click, derived from
  // SORT_LABELS so the two can never drift apart.
  const SORT_CYCLE = Object.keys(SORT_LABELS);
  const HEADER_CHECK_INTERVAL = 100; // ms
  const HEADER_TIMEOUT = 5000; // ms
  const EMPTY_QUEUE_CLASS = 'level-filter-empty-queue';

  const UI_IDS = {
    container: 'level-filter-container',
    dropdown: 'level-filter-dropdown',
    sortToggle: 'level-filter-sort-toggle',
    noItemsMessage: 'level-filter-no-items-message'
  };

  const STYLES = {
    dropdown: `
      margin: 0;
      padding: 3px 6px;
      font-size: 11px;
      border: 1px solid #999;
      border-radius: 3px;
      background: white;
      cursor: pointer;
      min-width: 100px;
    `,
    sortToggle: `
      margin: 0;
      padding: 3px 8px;
      font-size: 11px;
      line-height: 1;
      border: 1px solid #999;
      border-radius: 3px;
      background: white;
      cursor: pointer;
      white-space: nowrap;
    `,
    containerBase: `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.6);
      border-radius: 4px;
    `,
    containerAbsolute: `
      position: absolute;
      top: 50px;
      left: 10px;
      z-index: 1000;
    `,
    label: `
      color: white;
      font-size: 12px;
      font-weight: 500;
    `,
    noItemsMessage: `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border: 2px solid #ffc107;
      padding: 30px;
      border-radius: 10px;
      z-index: 100000;
      max-width: 500px;
      text-align: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    `,
    notification: `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translate(-50%, 0);
      background: #4a90e2;
      color: white;
      padding: 12px 24px;
      border-radius: 5px;
      z-index: 100000;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      animation: wkLevelFilterSlideDown 0.3s ease;
    `
  };

  const EMPTY_QUEUE_CSS = `
    /* Hide quiz interface when no items are available */
    body.${EMPTY_QUEUE_CLASS} .quiz {
      display: none !important;
    }

    /* Hide the completion/wrap-up screens when filtering */
    body.${EMPTY_QUEUE_CLASS} turbo-frame#quiz {
      display: none !important;
    }

    /* Ensure the message is visible */
    body.${EMPTY_QUEUE_CLASS} #${UI_IDS.noItemsMessage} {
      display: block !important;
    }

    @keyframes wkLevelFilterSlideDown {
      from { opacity: 0; transform: translate(-50%, -10px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }

    @keyframes wkLevelFilterSlideUp {
      from { opacity: 1; transform: translate(-50%, 0); }
      to { opacity: 0; transform: translate(-50%, -10px); }
    }
  `;

  // ============================================
  // SECTION 2: GLOBAL STATE
  // ============================================
  const state = {
    subjectLevelMap: {},
    subjectSrsMap: {}, // Map of subject_id -> srs_stage
    availableLevels: [], // Array of level numbers
    levelCounts: {}, // Object mapping level -> count
    dropdown: null,
    initialized: false,
    // Track levels with items in current queue (updated on each filter call)
    currentQueueLevels: new Set(),
    currentQueueLevelCounts: {},
    // Quiz-statistics tracking (see SECTION 10.5). completedTotal counts every
    // subject fully answered this session, across all levels, so the "completed"
    // counter stays a session-wide total. completedByLevel counts those same
    // subjects keyed by level, and sessionLevelTotal records each level's total
    // for the session (completed + remaining); together they drive the per-level
    // "to go" count and the progress bar for the selected level.
    completedTotal: 0,
    completedByLevel: {},
    sessionLevelTotal: {},
    statsListenersRegistered: false,
    // Track if user intentionally clicked home button
    userClickedHome: false,
    // Avoid registering multiple filters on turbo navigation
    queueFilterOwner: null,
    queueFilterRegistered: false
  };

  // ============================================
  // SECTION 3: WKOF CHECK
  // ============================================
  if (typeof wkof === 'undefined') {
    return;
  }

  // ============================================
  // SECTION 3.5: CSS INJECTION
  // ============================================

  /**
   * Inject CSS styles for the filter
   */
  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = EMPTY_QUEUE_CSS;
    document.head.appendChild(style);
  }

  // Inject CSS immediately
  injectCSS();

  // Setup home button tracking and navigation interceptor early
  setupHomeButtonTracking();
  setupNavigationInterceptor();
  // Listen for quiz lifecycle events so the per-level statistics stay in sync
  setupQuizStatisticsTracking();

  // ============================================
  // SECTION 4: DATA LOADING FUNCTIONS
  // ============================================

  /**
   * Load all items from WaniKani and build the level mapping
   * @returns {Promise<Object>} Object with level counts
   */
  function loadItemDataWithLevels() {
    state.subjectLevelMap = {};
    state.subjectSrsMap = {};
    state.availableLevels = [];
    state.levelCounts = {};
    // Start the session's statistics tracking from a clean slate
    state.completedTotal = 0;
    state.completedByLevel = {};
    state.sessionLevelTotal = {};

    const config = {
      wk_items: {
        options: {
          assignments: true
        },
        filters: {} // Get all items
      }
    };

    return wkof.ItemData.get_items(config)
      .then(items => {
        buildSubjectLevelMap(items);
        const counts = extractAvailableLevels(items);
        state.levelCounts = counts; // Store globally
        return counts;
      })
      .catch(error => {
        // Swallow error logging to keep console clean.
        alert('Level Filter: Failed to load level data. The filter will not work this session.');
        // Fallback: return empty counts
        return {};
      });
  }

  /**
   * Build a map of subject_id -> level for fast lookups
   * @param {Array} items - Items from ItemData
   */
  function buildSubjectLevelMap(items) {
    state.subjectLevelMap = {};
    state.subjectSrsMap = {};
    items.forEach(item => {
      if (!item || !item.data || !Number.isFinite(item.data.level)) {
        return;
      }

      state.subjectLevelMap[item.id] = item.data.level;

      // Record the SRS stage so the queue can be sorted by it
      if (item.assignments && Number.isFinite(item.assignments.srs_stage)) {
        state.subjectSrsMap[item.id] = item.assignments.srs_stage;
      }
    });
  }

  /**
   * Extract levels with available reviews and count items per level
   * @param {Array} items - Items from ItemData
   * @returns {Object} Object mapping level -> count of available items
   */
  function extractAvailableLevels(items) {
    const levelCounts = {};
    const now = new Date();

    items.forEach(item => {
      // Check if item has an assignment and is available for review
      if (!item.assignments) {
        return;
      }

      const assignment = item.assignments;

      // Item is available for review if:
      // 1. It has been started (srs_stage > 0 means it's been through lessons)
      // 2. It's available_at time has passed
      // 3. It's not burned (srs_stage < 9)
      if (assignment.srs_stage > 0 &&
        assignment.srs_stage < 9 &&
        assignment.available_at) {

        const availableAt = new Date(assignment.available_at);

        // Only count if available_at is in the past (available for review now)
        if (availableAt <= now) {
          const level = item.data.level;
          levelCounts[level] = (levelCounts[level] || 0) + 1;
        }
      }
    });

    // Convert to sorted array of levels
    state.availableLevels = Object.keys(levelCounts)
      .map(Number)
      .sort((a, b) => a - b);

    return levelCounts;
  }

  // ============================================
  // SECTION 5: UI FUNCTIONS
  // ============================================

  /**
   * Create a DOM element with common attributes
   * @param {string} tag - The element tag name
   * @param {Object} options - Element options
   * @returns {HTMLElement} The created element
   */
  function createElement(tag, options = {}) {
    const element = document.createElement(tag);

    if (options.id) {
      element.id = options.id;
    }
    if (options.text !== undefined) {
      element.textContent = options.text;
    }
    if (options.html !== undefined) {
      element.innerHTML = options.html;
    }
    if (options.cssText) {
      element.style.cssText = options.cssText;
    }
    if (options.attrs) {
      Object.entries(options.attrs).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
    }

    return element;
  }

  /**
   * Create the container for the dropdown UI
   * @param {HTMLSelectElement} dropdown - The dropdown to insert
   * @param {string} positionCss - Positioning CSS for the container
   * @returns {HTMLDivElement} The container element
   */
  function createDropdownContainer(dropdown, positionCss) {
    const container = createElement('div', {
      id: UI_IDS.container,
      cssText: STYLES.containerBase + positionCss
    });

    const label = createElement('label', {
      text: 'Level:',
      cssText: STYLES.label,
      attrs: { for: UI_IDS.dropdown }
    });

    container.appendChild(label);
    container.appendChild(dropdown);

    // Add the SRS sort-direction toggle next to the dropdown
    container.appendChild(createSortToggle());

    return container;
  }

  /**
   * Create the button that cycles the SRS sort mode
   * @returns {HTMLButtonElement} The toggle button element
   */
  function createSortToggle() {
    const button = createElement('button', {
      id: UI_IDS.sortToggle,
      cssText: STYLES.sortToggle,
      attrs: { type: 'button' }
    });

    updateSortToggleLabel(button);

    button.addEventListener('click', () => {
      saveSortDirection(nextSortDirection(getSortDirection()));
      updateSortToggleLabel(button);

      // Remove empty queue message and class
      clearEmptyQueueUI();

      // Re-run the filter (and re-sort) by refreshing the queue
      if (window.wkQueue && window.wkQueue.refresh) {
        window.wkQueue.refresh();
      }
    });

    return button;
  }

  /**
   * Update the toggle button's label/tooltip to reflect the current sort mode.
   * Tooltips describe what the next click will do.
   * @param {HTMLButtonElement} button - The toggle button
   */
  function updateSortToggleLabel(button) {
    const { text, title } = SORT_LABELS[getSortDirection()];
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
  }

  /**
   * Remove empty-queue UI and styling
   */
  function clearEmptyQueueUI() {
    const message = document.getElementById(UI_IDS.noItemsMessage);
    if (message) {
      message.remove();
    }
    if (document.body) {
      document.body.classList.remove(EMPTY_QUEUE_CLASS);
    }
  }

  /**
   * Create the level filter dropdown element
   * @param {Object} counts - Object mapping level -> count
   * @returns {HTMLSelectElement} The dropdown element
   */
  function createLevelDropdown(counts) {
    const dropdown = document.createElement('select');
    dropdown.id = UI_IDS.dropdown;
    dropdown.style.cssText = STYLES.dropdown;
    dropdown.setAttribute('aria-label', 'Filter by level');

    // Add "All Levels" option with total count
    const totalCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = `All Levels (${totalCount})`;
    dropdown.appendChild(allOption);

    // Add individual level options with counts
    // Only show levels that have items available
    const levelsToShow = state.availableLevels.length > 0
      ? state.availableLevels
      : Object.keys(counts).map(Number).sort((a, b) => a - b);

    levelsToShow.forEach(level => {
      const count = counts[level] || 0;
      if (count > 0) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = `Level ${level} (${count})`;
        dropdown.appendChild(option);
      }
    });

    // Restore saved selection
    const savedLevel = getSelectedLevel();
    if (savedLevel) {
      dropdown.value = savedLevel;
    }

    // Save selection on change
    dropdown.addEventListener('change', (e) => {
      const selected = e.target.value;
      saveSelectedLevel(selected);
      // Remove empty queue message and class
      clearEmptyQueueUI();

      // Trigger queue refresh if wkQueue is available
      if (window.wkQueue && window.wkQueue.refresh) {
        window.wkQueue.refresh();
      }
    });

    return dropdown;
  }

  /**
   * Update the dropdown options based on current queue state
   * Called after filtering to reflect actual remaining items
   */
  function updateDropdownOptions() {
    if (!state.dropdown) return;

    const counts = state.currentQueueLevelCounts;
    const currentValue = state.dropdown.value;

    // Clear existing options
    state.dropdown.innerHTML = '';

    // Add "All Levels" option with total count
    const totalCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = `All Levels (${totalCount})`;
    state.dropdown.appendChild(allOption);

    // Add individual level options with counts (sorted)
    const sortedLevels = Object.keys(counts)
      .map(Number)
      .filter(level => counts[level] > 0)
      .sort((a, b) => a - b);

    sortedLevels.forEach(level => {
      const count = counts[level];
      const option = document.createElement('option');
      option.value = level;
      option.textContent = `Level ${level} (${count})`;
      state.dropdown.appendChild(option);
    });

    // Restore selection if it still exists, otherwise keep current
    const parsedValue = Number.parseInt(currentValue, 10);
    if (currentValue === 'all' || (Number.isFinite(parsedValue) && counts[parsedValue] > 0)) {
      state.dropdown.value = currentValue;
    } else {
      // Current level no longer has items, this shouldn't happen
      // as we switch levels before this, but just in case
      state.dropdown.value = 'all';
    }
  }

  /**
   * Find the nearest scrollable ancestor of an element — the container whose
   * own scrolling actually moves the page content.
   *
   * On WaniKani's review page the window/document does NOT scroll; an inner
   * element does. That means an absolutely-positioned menu anchored to <body>
   * is positioned against the (viewport-sized) initial containing block and
   * appears to float, staying pinned on screen as you scroll. Anchoring it
   * inside the real scroll container instead lets it scroll away with the
   * content, since absolutely-positioned descendants of a scroll container
   * participate in that container's scrollable overflow.
   *
   * @param {HTMLElement} start - Element to search upward from
   * @returns {HTMLElement|null} The scroll container, or null if none found
   */
  function findScrollContainer(start) {
    let node = start || null;
    while (node && node !== document.body && node !== document.documentElement) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Anchor the menu container to the page so it scrolls away with the content
   * instead of floating. Prefers the inner scroll container (see
   * findScrollContainer); falls back to <body> when the window is the scroller.
   * @param {HTMLDivElement} container - The menu container to place
   * @param {HTMLElement|null} anchor - A known in-content element to search from
   */
  function anchorMenuToScroll(container, anchor) {
    const scrollContainer = findScrollContainer(anchor) ||
                            findScrollContainer(document.querySelector('.quiz'));

    if (scrollContainer) {
      // The container must be a positioned ancestor for the absolutely
      // positioned menu to be placed relative to it (and scroll with it).
      if (window.getComputedStyle(scrollContainer).position === 'static') {
        scrollContainer.style.position = 'relative';
      }
      scrollContainer.appendChild(container);
    } else {
      // Window is the scroller (or no container found): body-anchored absolute
      // positioning scrolls with the document just fine.
      document.body.appendChild(container);
    }
  }

  /**
   * Insert the dropdown into the review page header
   * @param {HTMLSelectElement} dropdown - The dropdown to insert
   */
  function insertDropdownIntoPage(dropdown) {
    let attempts = 0;
    const maxAttempts = HEADER_TIMEOUT / HEADER_CHECK_INTERVAL;

    const waitForHeader = setInterval(() => {
      attempts++;

      // Look for the home button or header area
      const homeButton = document.querySelector('.wk-icon--home') ||
                        document.querySelector('[href="/"]');
      const header = homeButton ? homeButton.closest('header') : document.querySelector('header');

      if (homeButton || header) {
        clearInterval(waitForHeader);

        // Anchor inside the page's scroll container (not the sticky header) so
        // the menu stays at its starting position and scrolls away with the
        // content instead of floating as you scroll down.
        const container = createDropdownContainer(dropdown, STYLES.containerAbsolute);
        anchorMenuToScroll(container, header || homeButton);

      } else if (attempts >= maxAttempts) {
        clearInterval(waitForHeader);

        // Fallback: insert at top-left corner, still anchored to the scroll
        // container where possible so it scrolls with the page.
        if (document.body) {
          const container = createDropdownContainer(dropdown, STYLES.containerAbsolute);
          anchorMenuToScroll(container, null);
        }
      }
    }, HEADER_CHECK_INTERVAL);
  }

  /**
   * Setup the UI by creating and inserting the dropdown
   */
  function setupUI() {
    if (document.getElementById(UI_IDS.container)) {
      return;
    }

    const counts = Object.keys(state.levelCounts).length > 0
      ? state.levelCounts
      : state.currentQueueLevelCounts;

    if (Object.keys(counts).length === 0) {
      return;
    }

    state.dropdown = createLevelDropdown(counts);
    insertDropdownIntoPage(state.dropdown);
  }

  // ============================================
  // SECTION 6: FILTERING LOGIC
  // ============================================

  /**
   * Setup queue manipulation using wkQueue
   */
  function setupQueueFilter() {
    if (!window.wkQueue || !window.wkQueue.addTotalChange) {
      return;
    }

    if (state.queueFilterOwner === window.wkQueue && state.queueFilterRegistered) {
      return;
    }

    // Register our filter callback
    window.wkQueue.addTotalChange(filterQueueByLevel, {
      openFramework: true,
      openFrameworkGetItemsConfig: 'assignments'
    });

    state.queueFilterOwner = window.wkQueue;
    state.queueFilterRegistered = true;
  }

  /**
   * Filter the queue to only include items from the selected level
   * This function is called by wkQueue whenever the queue changes
   */
  function filterQueueByLevel(queue) {
    // Selection decides which items stay; sorting is applied once, uniformly.
    return sortQueueBySrs(selectQueueForLevel(queue));
  }

  /**
   * Pick the set of queue items to review based on the selected level, updating
   * the tracking state and UI as a side effect. Returns the (unsorted) queue.
   * @param {Array} queue - The current review queue
   * @returns {Array} The queue items to review
   */
  function selectQueueForLevel(queue) {
    const selectedLevel = getSelectedLevel();

    // Remove empty queue styling first
    clearEmptyQueueUI();

    // Track what levels are available in the current queue
    state.currentQueueLevels.clear();
    state.currentQueueLevelCounts = {};
    for (const queueItem of queue) {
      const itemLevel = getQueueItemLevel(queueItem);
      if (itemLevel !== null) {
        state.currentQueueLevels.add(itemLevel);
        state.currentQueueLevelCounts[itemLevel] = (state.currentQueueLevelCounts[itemLevel] || 0) + 1;
      }
    }

    // The queue handed to us excludes already-finished items, so for each level
    // (remaining items) + (items completed so far) is that level's session
    // total. Record it so the statistics can derive the "completed"/"to go"
    // split for whichever level is selected.
    captureSessionLevelTotals();

    // Ensure UI exists and update dropdown to reflect current queue state
    if (!state.dropdown) {
      setupUI();
    }
    updateDropdownOptions();

    // If "all" or no selection, return the full queue
    if (!selectedLevel || selectedLevel === 'all') {
      return queue;
    }

    const selectedLevelNum = Number.parseInt(selectedLevel, 10);
    if (!Number.isFinite(selectedLevelNum)) {
      return queue;
    }

    // Filter queue items based on level
    const filteredQueue = queue.filter(queueItem => {
      const itemLevel = getQueueItemLevel(queueItem);
      return itemLevel === selectedLevelNum;
    });

    // If no items match, find the closest level with items in the current queue
    if (filteredQueue.length === 0) {
      const closestLevel = findClosestLevelWithItems(queue, selectedLevelNum);

      if (closestLevel !== null) {
        // Filter for the new level
        const newLevelQueue = queue.filter(queueItem => {
          const itemLevel = getQueueItemLevel(queueItem);
          return itemLevel === closestLevel;
        });

        // Show notification to user with accurate count
        showLevelSwitchNotification(selectedLevelNum, closestLevel, newLevelQueue.length);

        // Update the saved level
        saveSelectedLevel(closestLevel.toString());

        // Update the dropdown UI
        if (state.dropdown) {
          state.dropdown.value = closestLevel.toString();
        }

        return newLevelQueue;
      }

      // No levels have items at all - show message
      document.body.classList.add(EMPTY_QUEUE_CLASS);
      showNoItemsMessage();
      return queue; // Return original queue to prevent redirect
    }

    return filteredQueue;
  }

  /**
   * Find the closest level that has available items in the current queue
   * @param {Array} queue - The current review queue
   * @param {number} targetLevel - The level to find closest match for
   * @returns {number|null} Closest level with items, or null if none
   */
  function findClosestLevelWithItems(queue, targetLevel) {
    // Build a set of levels that actually have items in the current queue
    const levelsWithItems = new Set();
    for (const queueItem of queue) {
      const itemLevel = getQueueItemLevel(queueItem);
      if (itemLevel !== null && itemLevel !== targetLevel) {
        levelsWithItems.add(itemLevel);
      }
    }

    if (levelsWithItems.size === 0) {
      return null;
    }

    // Find the level with minimum distance
    let closestLevel = null;
    let minDistance = Infinity;

    for (const level of levelsWithItems) {
      const distance = Math.abs(level - targetLevel);

      // If distance is smaller, or same distance but lower level (prefer lower)
      if (distance < minDistance || (distance === minDistance && level < closestLevel)) {
        minDistance = distance;
        closestLevel = level;
      }
    }

    return closestLevel;
  }

  // ============================================
  // SECTION 7: STORAGE FUNCTIONS
  // ============================================

  /**
   * Normalize a stored level value to 'all' or a numeric string
   * @param {string|number|null|undefined} value - Stored or incoming value
   * @returns {string} Normalized level value
   */
  function normalizeSelectedLevel(value) {
    if (value === null || value === undefined || value === 'all') {
      return 'all';
    }

    const stringValue = String(value).trim();
    if (!/^\d+$/.test(stringValue)) {
      return 'all';
    }

    const parsed = Number.parseInt(stringValue, 10);
    return parsed > 0 ? String(parsed) : 'all';
  }

  /**
   * Get the currently selected level from localStorage
   * @returns {string} The selected level or 'all'
   */
  function getSelectedLevel() {
    const storedValue = localStorage.getItem(STORAGE_KEY);
    const normalized = normalizeSelectedLevel(storedValue);

    if (normalized === 'all' && storedValue !== null) {
      localStorage.removeItem(STORAGE_KEY);
    }

    return normalized;
  }

  /**
   * Get the selected level as a number, or null when "All Levels" is selected.
   * getSelectedLevel() (via normalizeSelectedLevel) always yields 'all' or a
   * positive-integer string, so the parse here never produces NaN.
   * @returns {number|null} The selected level number, or null for "all"
   */
  function getSelectedLevelNumber() {
    const selectedLevel = getSelectedLevel();
    return selectedLevel === 'all' ? null : Number.parseInt(selectedLevel, 10);
  }

  /**
   * Save the selected level to localStorage
   * @param {string|number} level - The level to save
   */
  function saveSelectedLevel(level) {
    const normalized = normalizeSelectedLevel(level);
    if (normalized === 'all') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, normalized);
    }
  }

  /**
   * Whether a sort mode is a valid, non-default value worth persisting.
   * Descending is the default and is never stored.
   * @param {string} direction - The sort mode to test
   * @returns {boolean} True if the mode should be persisted
   */
  function isPersistedSortDirection(direction) {
    return SORT_CYCLE.includes(direction) && direction !== SORT_DESC;
  }

  /**
   * Get the current SRS sort mode from localStorage
   * @returns {string} SORT_DESC (default), SORT_ASC, or SORT_NONE
   */
  function getSortDirection() {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    return isPersistedSortDirection(stored) ? stored : SORT_DESC;
  }

  /**
   * Save the SRS sort mode to localStorage
   * @param {string} direction - SORT_DESC, SORT_ASC, or SORT_NONE
   */
  function saveSortDirection(direction) {
    if (isPersistedSortDirection(direction)) {
      localStorage.setItem(SORT_STORAGE_KEY, direction);
    } else {
      // Descending is the default, so no need to persist it
      localStorage.removeItem(SORT_STORAGE_KEY);
    }
  }

  /**
   * Get the next sort mode in the cycle (desc -> asc -> none -> desc)
   * @param {string} direction - The current sort mode
   * @returns {string} The next sort mode
   */
  function nextSortDirection(direction) {
    const index = SORT_CYCLE.indexOf(direction);
    return SORT_CYCLE[(index + 1) % SORT_CYCLE.length];
  }

  // ============================================
  // SECTION 8: EMPTY QUEUE UI
  // ============================================

  /**
   * Show a message when there are no items from the selected level
   */
  function showNoItemsMessage() {
    // Remove existing message if any
    const existing = document.getElementById(UI_IDS.noItemsMessage);
    if (existing) {
      return; // Message already showing
    }

    const selectedLevel = getSelectedLevel();
    const message = createElement('div', {
      id: UI_IDS.noItemsMessage,
      cssText: STYLES.noItemsMessage,
      html: `
      <h2 style="margin-top: 0; color: #333;">No Items Available</h2>
      <p style="font-size: 16px; color: #666;">
        There are no review items available for <strong>Level ${selectedLevel}</strong> in the current session.
      </p>
      <p style="font-size: 14px; color: #888;">
        Try selecting a different level from the dropdown above, or select "All Levels" to review everything.
      </p>
    `
    });

    document.body.appendChild(message);
  }

  /**
   * Show a brief notification when auto-switching levels
   * @param {number} fromLevel - The level we're switching from
   * @param {number} toLevel - The level we're switching to
   * @param {number} itemCount - Number of items in the new level
   */
  function showLevelSwitchNotification(fromLevel, toLevel, itemCount) {
    const notification = createElement('div', {
      cssText: STYLES.notification
    });

    notification.textContent = `Level ${fromLevel} complete! Switched to Level ${toLevel} (${itemCount} items)`;

    document.body.appendChild(notification);

    // Auto-remove after 3 seconds
    setTimeout(() => {
      notification.style.animation = 'wkLevelFilterSlideUp 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // ============================================
  // SECTION 9: NAVIGATION INTERCEPTOR
  // ============================================

  /**
   * Track clicks on the home button to distinguish user navigation from automatic redirects
   */
  function setupHomeButtonTracking() {
    document.addEventListener('click', (e) => {
      // Check if user clicked on home link or home icon
      const homeLink = e.target.closest('a[href="/"], a[href="/dashboard"], .wk-icon--home');
      if (homeLink) {
        state.userClickedHome = true;
        // Reset after a short delay in case navigation doesn't happen
        setTimeout(() => { state.userClickedHome = false; }, 1000);
      }
    }, true); // Capture phase to catch before navigation
  }

  /**
   * Setup interceptor to prevent redirect when switching levels
   * This catches the redirect that wkQueue/WaniKani triggers when queue is empty
   */
  function setupNavigationInterceptor() {
    document.addEventListener('turbo:before-visit', (event) => {
      // Only intercept if we're on a review page
      if (!isReviewPage()) return;

      // Check if navigating to dashboard/home
      const targetUrl = event.detail.url;
      const isHomeRedirect = targetUrl.endsWith('/') ||
                             targetUrl.includes('/dashboard') ||
                             targetUrl.match(/wanikani\.com\/?$/) ||
                             targetUrl.match(/wanikani\.com\/dashboard/);

      if (!isHomeRedirect) return;

      // If user clicked home button, allow navigation
      if (state.userClickedHome) {
        state.userClickedHome = false;
        return;
      }

      // Check if we have a level filter active
      const selectedLevel = getSelectedLevel();
      if (!selectedLevel || selectedLevel === 'all') return;

      const selectedLevelNum = Number.parseInt(selectedLevel, 10);
      if (!Number.isFinite(selectedLevelNum)) return;

      // Check if there are other levels with items in the current queue
      const otherLevels = [...state.currentQueueLevels].filter(l => l !== selectedLevelNum);

      if (otherLevels.length === 0) return; // No other levels, allow redirect

      // Find closest level
      let closestLevel = null;
      let minDistance = Infinity;

      for (const level of otherLevels) {
        const distance = Math.abs(level - selectedLevelNum);
        if (distance < minDistance || (distance === minDistance && level < closestLevel)) {
          minDistance = distance;
          closestLevel = level;
        }
      }

      if (closestLevel !== null) {
        // Prevent the redirect
        event.preventDefault();

        // Switch to the new level
        saveSelectedLevel(closestLevel.toString());
        if (state.dropdown) {
          state.dropdown.value = closestLevel.toString();
        }

        // Show notification
        const itemCount = state.currentQueueLevelCounts[closestLevel] || 0;
        showLevelSwitchNotification(selectedLevelNum, closestLevel, itemCount);

        // Refresh the queue to load the new level's items
        if (window.wkQueue && window.wkQueue.refresh) {
          window.wkQueue.refresh();
        }
      }
    }, true); // Use capture phase to intercept before other handlers
  }

  // ============================================
  // SECTION 10: UTILITY FUNCTIONS
  // ============================================

  /**
   * Get a cached numeric value for a queue item, falling back to a fresh read
   * and caching the result for later lookups.
   * @param {Object} queueItem - Queue item from wkQueue
   * @param {Object} cache - Map of subject_id -> value to read/populate
   * @param {Function} read - Reads the value from the item when not cached
   * @returns {number|null} The value, or null if unavailable
   */
  function getCachedQueueItemValue(queueItem, cache, read) {
    if (!queueItem || !queueItem.item) {
      return null;
    }

    const item = queueItem.item;
    let value = cache[item.id];

    if (!Number.isFinite(value)) {
      const fresh = read(item);
      if (Number.isFinite(fresh)) {
        value = fresh;
        cache[item.id] = value;
      }
    }

    return Number.isFinite(value) ? value : null;
  }

  /**
   * Get the level for a queue item, with a fallback to the item data
   * @param {Object} queueItem - Queue item from wkQueue
   * @returns {number|null} Level number, or null if unavailable
   */
  function getQueueItemLevel(queueItem) {
    return getCachedQueueItemValue(queueItem, state.subjectLevelMap,
      item => item.data && item.data.level);
  }

  /**
   * Get the SRS stage for a queue item, with a fallback to the item assignment
   * @param {Object} queueItem - Queue item from wkQueue
   * @returns {number|null} SRS stage, or null if unavailable
   */
  function getQueueItemSrs(queueItem) {
    return getCachedQueueItemValue(queueItem, state.subjectSrsMap,
      item => item.assignments && item.assignments.srs_stage);
  }

  /**
   * Sort a queue by SRS stage according to the current sort mode. When sorting
   * is off (SORT_NONE) the queue is returned unchanged to preserve its original
   * (random) order. Otherwise returns a new array with items lacking a known
   * SRS stage placed last.
   * @param {Array} queue - The queue to sort
   * @returns {Array} The queue, sorted or untouched depending on the mode
   */
  function sortQueueBySrs(queue) {
    const direction = getSortDirection();
    if (direction === SORT_NONE) {
      return queue;
    }

    const factor = direction === SORT_ASC ? 1 : -1;

    return [...queue].sort((a, b) => {
      const srsA = getQueueItemSrs(a);
      const srsB = getQueueItemSrs(b);

      if (srsA === null && srsB === null) return 0;
      if (srsA === null) return 1;
      if (srsB === null) return -1;

      return (srsA - srsB) * factor;
    });
  }

  /**
   * Check if the current page is a review page
   * @returns {boolean} True if on review page
   */
  function isReviewPage() {
    return window.location.pathname.includes('/review') ||
           window.location.pathname.includes('/extra_study');
  }

  // ============================================
  // SECTION 10.5: QUIZ STATISTICS SYNC
  // ============================================
  //
  // WaniKani's review header is driven by two Stimulus controllers:
  //   - `quiz-statistics` exposes the "completed" and "to go" counts via the
  //     `completeCount` / `remainingCount` targets (plus `percentCorrect`).
  //   - `quiz-progress` draws the progress bar via updateProgress({ detail:
  //     { percentComplete } }).
  // When the queue is filtered, the Queue Manipulator rewrites the queue and
  // the `remainingCount` target, but it never touches `completeCount`, and it
  // resets the quiz's internal item total to the *filtered* length. Once we
  // auto-switch levels the native code derives the counts from mismatched
  // numbers (a session-wide "completed" against a per-level total), so both
  // counts and the progress bar drift. To keep them correct we own the
  // statistics while a specific level is selected and re-assert them on every
  // relevant quiz event: "completed" stays a session-wide total of every item
  // finished (across all levels), while "to go" and the progress bar describe
  // just the selected level, using our own per-level completion counts.

  /**
   * Resolve a Stimulus controller instance by identifier, or null if Stimulus
   * or the controller's element is not present.
   * @param {string} name - The controller identifier (e.g. 'quiz-statistics')
   * @returns {Object|null} The controller instance, or null
   */
  function getStimulusController(name) {
    const stimulus = window.Stimulus;
    if (!stimulus || typeof stimulus.getControllerForElementAndIdentifier !== 'function') {
      return null;
    }
    const element = document.querySelector(`[data-controller~="${name}"]`);
    if (!element) {
      return null;
    }
    return stimulus.getControllerForElementAndIdentifier(element, name);
  }

  /**
   * Record each level's total number of subjects for the session. The queue
   * passed to the filter excludes finished items, so (remaining for a level) +
   * (completed for that level) is its session total. This is recomputed from
   * scratch on every manipulation rather than kept monotonic, so that if the
   * session legitimately shrinks (e.g. items dropped during wrap-up, or an
   * extra_study queue that is smaller), the total follows it down and "to go"
   * can still reach 0.
   */
  function captureSessionLevelTotals() {
    for (const key of Object.keys(state.currentQueueLevelCounts)) {
      const level = Number(key);
      const remaining = state.currentQueueLevelCounts[level] || 0;
      const completed = state.completedByLevel[level] || 0;
      state.sessionLevelTotal[level] = remaining + completed;
    }
  }

  /**
   * Record a completed subject. Always bumps the session-wide completedTotal so
   * the "completed" counter reflects every item finished this session, across
   * all levels. Then attributes the subject to its level so the per-level "to
   * go" count and progress bar can advance. Prefers the subject's real level
   * from subjectLevelMap, but falls back to the selected level when that map
   * has not loaded yet: while a specific level is filtered the queue only holds
   * items of that level, so an unmapped completion necessarily belongs to it.
   * Without the fallback, every completion answered before the (async) item
   * data finished loading would be dropped, permanently under-counting the
   * level for the rest of the session.
   * @param {number} subjectId - The completed subject's id
   */
  function recordCompletedSubject(subjectId) {
    state.completedTotal += 1;

    let level = state.subjectLevelMap[subjectId];
    if (!Number.isFinite(level)) {
      level = getSelectedLevelNumber();
    }
    if (!Number.isFinite(level)) {
      return;
    }
    state.completedByLevel[level] = (state.completedByLevel[level] || 0) + 1;
  }

  /**
   * Update the progress bar to a given completion percentage, if the
   * quiz-progress controller is available.
   * @param {number} percentComplete - Completion percentage (0-100)
   */
  function updateQuizProgressBar(percentComplete) {
    try {
      const controller = getStimulusController('quiz-progress');
      if (controller && typeof controller.updateProgress === 'function') {
        controller.updateProgress({ detail: { percentComplete } });
      }
    } catch (error) {
      // Ignore - the progress bar is non-essential and its internals may change
    }
  }

  /**
   * Re-assert the quiz statistics while a specific level is filtered. Rewrites
   * the "completed" count to the session-wide total (every item finished across
   * all levels) and the "to go" count plus progress bar to describe the selected
   * level. No-op when no specific level is selected (the native counts are
   * already correct for "All Levels") or when the statistics elements are not
   * present.
   */
  function syncQuizStatistics() {
    const levelNum = getSelectedLevelNumber();
    if (levelNum === null) {
      return;
    }

    const total = state.sessionLevelTotal[levelNum];
    if (!Number.isFinite(total)) {
      return; // Haven't observed this level in the queue yet
    }

    const completeTarget = document.querySelector('[data-quiz-statistics-target="completeCount"]');
    const remainingTarget = document.querySelector('[data-quiz-statistics-target="remainingCount"]');
    if (!completeTarget || !remainingTarget) {
      return;
    }

    const levelComplete = state.completedByLevel[levelNum] || 0;
    const remaining = Math.max(0, total - levelComplete);

    // "Completed" stays a session-wide total (every item finished across all
    // levels); "to go" and the progress bar describe just the selected level.
    completeTarget.textContent = String(state.completedTotal);
    remainingTarget.textContent = String(remaining);

    const percentComplete = total > 0 ? Math.round((100 * levelComplete) / total) : 100;
    updateQuizProgressBar(percentComplete);
  }

  /**
   * Defer a statistics sync to the next tick so it runs after WaniKani's own
   * (native) handlers have updated the counts for the same event.
   */
  function scheduleQuizStatisticsSync() {
    setTimeout(syncQuizStatistics, 0);
  }

  /**
   * Register the quiz lifecycle listeners that keep the per-level statistics in
   * sync. Registered once, early; recordCompletedSubject's selected-level
   * fallback means completions still count even if one fires before the item
   * data finishes loading.
   */
  function setupQuizStatisticsTracking() {
    if (state.statsListenersRegistered) {
      return;
    }
    state.statsListenersRegistered = true;

    // A subject is fully answered: attribute it to its level, then re-sync.
    window.addEventListener('didCompleteSubject', (event) => {
      const subject = event.detail
        && event.detail.subjectWithStats
        && event.detail.subjectWithStats.subject;
      if (subject) {
        recordCompletedSubject(subject.id);
      }
      scheduleQuizStatisticsSync();
    });

    // A new question is shown (including right after a queue manipulation or
    // level switch): re-assert the counts the native code may have recomputed.
    window.addEventListener('willShowNextQuestion', scheduleQuizStatisticsSync);
  }

  // ============================================
  // SECTION 11: INITIALIZATION
  // ============================================

  /**
   * Initialize the level filter system
   */
  function initializeLevelFilter() {
    // Only run on review pages
    if (!isReviewPage()) {
      return;
    }

    // Prevent double initialization
    if (state.initialized) {
      return;
    }

    state.initialized = true;

    // Include ItemData module
    wkof.include('ItemData');

    // Wait for module to be ready
    wkof.ready('ItemData')
      .then(() => {
        // Load all items and build level map
        return loadItemDataWithLevels();
      })
      .then((levels) => {
        // Setup queue filter using wkQueue
        setupQueueFilter();

        // Create and insert UI
        setupUI();
      })
      .catch(error => {
        state.initialized = false; // Allow retry on error
      });
  }

  /**
   * Handle turbo navigation events
   */
  function handleTurboLoad() {
    // Remove UI if not on review page
    if (!isReviewPage()) {
      cleanupUI();
      state.initialized = false; // Allow re-initialization if we return to review page
      return;
    }

    // Use setTimeout to ensure DOM is ready
    setTimeout(() => {
      initializeLevelFilter();
    }, 0);
  }

  /**
   * Clean up the filter UI when leaving review page
   */
  function cleanupUI() {
    // Remove the dropdown container
    const container = document.getElementById(UI_IDS.container);
    if (container) {
      container.remove();
    }

    // Remove empty queue styling
    clearEmptyQueueUI();

    // Reset dropdown reference
    state.dropdown = null;

    // Drop the session's statistics tracking so it can't leak into the next
    // review session (the window listeners outlive a single session).
    state.completedTotal = 0;
    state.completedByLevel = {};
    state.sessionLevelTotal = {};
  }

  // ============================================
  // SECTION 12: STARTUP
  // ============================================

  // Initial load
  if (isReviewPage()) {
    initializeLevelFilter();
  } else {
    cleanupUI(); // Clean up any leftover UI from previous session
  }

  // Handle turbo page transitions
  addEventListener('turbo:load', handleTurboLoad);
  addEventListener('turbo:render', handleTurboLoad);

})();
