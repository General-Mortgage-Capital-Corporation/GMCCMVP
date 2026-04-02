/**
 * GMCC Property Search Dashboard
 */

// =============================================================================
// State
// =============================================================================

let currentListings = [];
let currentPage = 1;
let perPage = 10;
let availablePrograms = [];
let selectedPrograms = [];
let activeTab = 'find'; // 'find' or 'program'
let programLocations = []; // from /api/program-locations
let currentSearchController = null; // AbortController for in-flight search
let currentMatchController = null; // AbortController for in-flight batch match
let currentModalListing = null; // track which listing the modal is showing

// Marketing tab state
let mkSortColumn = 'price';
let mkSortDirection = 'desc';
let mkAggregated = null; // cached aggregated locations across all programs

// Chip filter state (shared across tabs)
let activeChipFilters = new Set(); // e.g. 'mmct', 'lmi', 'aahp', 'under500k', etc.
// Marketing-only filters
let mkProgramFilter = '';
let mkTypeFilter = '';

const STATUS_ICONS = {
    pass: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unverified: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#94a3b8" stroke-width="2"/><path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

// =============================================================================
// Utility
// =============================================================================

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatPrice(price) {
    if (price == null) return 'Price N/A';
    return '$' + Number(price).toLocaleString();
}

function formatPhone(phone) {
    if (!phone) return 'N/A';
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    return phone;
}

function formatDistance(distance) {
    if (!distance || distance === 999) return '';
    return distance < 1
        ? `${(distance * 5280).toFixed(0)} ft away`
        : `${distance.toFixed(1)} mi away`;
}

function formatNumber(n) {
    if (n == null) return 'N/A';
    return Number(n).toLocaleString();
}

function formatCurrency(n) {
    if (n == null) return 'N/A';
    return '$' + Number(n).toLocaleString();
}

function formatPct(n) {
    if (n == null) return 'N/A';
    return parseFloat(n).toFixed(1) + '%';
}

function renderSimpleMarkdown(text) {
    let escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const lines = escaped.split('\n');
    let html = '';
    let inList = false;
    lines.forEach(line => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            if (!inList) { html += '<ul>'; inList = true; }
            html += '<li>' + trimmed.slice(2) + '</li>';
        } else {
            if (inList) { html += '</ul>'; inList = false; }
            if (html.length > 0) html += '<br>';
            html += line;
        }
    });
    if (inList) html += '</ul>';
    return html;
}

// =============================================================================
// Chip Filters
// =============================================================================

/**
 * Check whether a listing passes the active chip filters.
 * Default: OR logic — listing passes if it matches ANY selected chip.
 * To switch to AND logic, change `filterMode` to 'and'.
 */
const CHIP_FILTER_MODE = 'and'; // Change to 'or' for OR (any-match) logic

function listingPassesChipFilters(listing, filters) {
    if (!filters || filters.size === 0) return true;

    const census = listing.censusData || {};
    const price = listing.price || 0;
    const incomeLevel = (census.tract_income_level || '').toLowerCase();
    const minorityPct = census.tract_minority_pct;

    const checks = {
        mmct: () => minorityPct != null && minorityPct > 50,
        lmi: () => incomeLevel === 'low' || incomeLevel === 'moderate',
        aahp: () => {
            // Majority AA (African American) or HP (Hispanic/Latino) — over 50% combined
            const black = census.demographics_black || 0;
            const hispanic = census.demographics_hispanic || 0;
            const total = census.demographics_total || 1;
            return ((black + hispanic) / total) > 0.5;
        },
        under500k: () => price > 0 && price < 500000,
        '500kto1m': () => price >= 500000 && price <= 1000000,
        '1mto3m': () => price > 1000000 && price <= 3000000,
        over3m: () => price > 3000000,
    };

    const activeChecks = [...filters].filter(f => checks[f]);
    if (activeChecks.length === 0) return true;

    if (CHIP_FILTER_MODE === 'and') {
        return activeChecks.every(f => checks[f]());
    } else {
        return activeChecks.some(f => checks[f]());
    }
}

function initChipFilterListeners(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.chip-filter').forEach(chip => {
        chip.addEventListener('click', () => {
            const filter = chip.dataset.filter;
            chip.classList.toggle('active');
            if (activeChipFilters.has(filter)) {
                activeChipFilters.delete(filter);
            } else {
                activeChipFilters.add(filter);
            }
            currentPage = 1;
            if (activeTab === 'marketing') {
                renderMarketingPage();
            } else {
                renderFilteredPage();
            }
        });
    });
}

function resetChipFilters() {
    activeChipFilters.clear();
    document.querySelectorAll('.chip-filter.active').forEach(c => c.classList.remove('active'));
}

// =============================================================================
// Address Autocomplete (via server-side Places API proxy)
// =============================================================================

let autocompleteTimer = null;
let autocompleteDropdown = null;

function initAutocomplete() {
    const input = document.getElementById('searchQuery');
    if (!input) return;

    // Create dropdown container
    const wrapper = input.parentNode;
    wrapper.style.position = 'relative';

    autocompleteDropdown = document.createElement('div');
    autocompleteDropdown.className = 'autocomplete-dropdown';
    wrapper.appendChild(autocompleteDropdown);

    // Debounced fetch on input
    input.addEventListener('input', () => {
        clearTimeout(autocompleteTimer);
        const val = input.value.trim();
        if (val.length < 3) {
            autocompleteDropdown.innerHTML = '';
            autocompleteDropdown.style.display = 'none';
            return;
        }
        autocompleteTimer = setTimeout(() => fetchSuggestions(val), 250);
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            autocompleteDropdown.style.display = 'none';
        }
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
        if (!items.length) return;

        const active = autocompleteDropdown.querySelector('.autocomplete-item.active');
        let idx = Array.from(items).indexOf(active);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (active) active.classList.remove('active');
            idx = (idx + 1) % items.length;
            items[idx].classList.add('active');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (active) active.classList.remove('active');
            idx = idx <= 0 ? items.length - 1 : idx - 1;
            items[idx].classList.add('active');
        } else if (e.key === 'Enter' && active) {
            e.preventDefault();
            selectSuggestion(active.dataset.text);
        }
    });
}

async function fetchSuggestions(query) {
    try {
        const resp = await fetch(`/api/autocomplete?input=${encodeURIComponent(query)}`);
        if (!resp.ok) throw new Error('autocomplete failed');
        const data = await resp.json();
        renderSuggestions(data.suggestions || []);
    } catch {
        autocompleteDropdown.style.display = 'none';
    }
}

function renderSuggestions(suggestions) {
    if (!suggestions.length) {
        autocompleteDropdown.style.display = 'none';
        return;
    }

    autocompleteDropdown.innerHTML = suggestions.map(s =>
        `<div class="autocomplete-item" data-text="${escapeHtml(s.text)}">${escapeHtml(s.text)}</div>`
    ).join('');
    autocompleteDropdown.style.display = 'block';

    autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => selectSuggestion(item.dataset.text));
        item.addEventListener('mouseenter', () => {
            autocompleteDropdown.querySelector('.active')?.classList.remove('active');
            item.classList.add('active');
        });
    });
}

function selectSuggestion(text) {
    const input = document.getElementById('searchQuery');
    // Strip country suffix — RentCast doesn't use it
    input.value = text.replace(/,\s*USA$/, '');
    autocompleteDropdown.style.display = 'none';

    // Update map marker if map is initialized
    if (window._searchMap) {
        geocodeAndMoveMap(input.value);
    }
}

// =============================================================================
// API
// =============================================================================

async function searchListings(query, radius, searchType) {
    // Cancel any in-flight search
    if (currentSearchController) currentSearchController.abort();
    if (currentMatchController) currentMatchController.abort();
    currentSearchController = new AbortController();

    const params = new URLSearchParams({ query, radius, search_type: searchType });
    const programs = getSelectedProgramsParam();
    if (programs) params.set('programs', programs);

    // Pass map marker lat/lng so server uses the actual searched address as distance center
    const marker = window._searchMapMarker;
    if (marker && marker.position) {
        params.set('lat', marker.position.lat);
        params.set('lng', marker.position.lng);
    }

    const response = await fetch(`/api/search?${params}`, { signal: currentSearchController.signal });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    return await response.json();
}

// =============================================================================
// Program Matching
// =============================================================================

function matchPageListings() {
    const cards = document.querySelectorAll('#resultsGrid .property-card');

    // Collect listings that need matching
    const toMatch = [];
    cards.forEach(card => {
        const index = parseInt(card.getAttribute('data-index'));
        const listing = currentListings[index];
        if (!listing || listing.matchData || listing.matchLoading) return;
        listing.matchLoading = true;
        toMatch.push({ index, listing });
    });

    if (toMatch.length === 0) return;

    // Cancel any in-flight batch match request
    if (currentMatchController) currentMatchController.abort();
    currentMatchController = new AbortController();

    // Capture reference to verify listings haven't been replaced by a new search
    const expectedListings = currentListings;

    // Batch match all visible listings in one request
    fetch('/api/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toMatch.map(item => item.listing)),
        signal: currentMatchController.signal,
    })
    .then(r => { if (!r.ok) throw new Error(`Batch match failed (${r.status})`); return r.json(); })
    .then(data => {
        // Discard results if a new search has replaced currentListings
        if (currentListings !== expectedListings) return;

        if (data.success && data.results) {
            data.results.forEach((result, i) => {
                if (!result) return;
                const { index, listing } = toMatch[i];
                listing.matchData = { programs: result.programs };
                listing.censusData = result.census_data || null;
                listing.matchLoading = false;
                updateCardPrograms(index, result.programs);
                refreshModalIfOpen(listing);
            });

            // Clear pre-screen message once real match data arrives
            if (selectedPrograms.length > 0) {
                showMessage(null);
            }

            // Re-render once with latest match data
            renderFilteredPage();
        }
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        toMatch.forEach(({ index, listing }) => {
            listing.matchLoading = false;
            updateCardPrograms(index, []);
        });
        showError('Failed to check program eligibility. Try refreshing.');
    });
}

function updateCardPrograms(index, programs) {
    const card = document.querySelector(`[data-index="${index}"]`);
    if (!card) return;

    const programsArea = card.querySelector('.card-programs');
    if (!programsArea) return;

    const eligible = programs.filter(p => p.status !== 'Ineligible');

    if (eligible.length === 0) {
        programsArea.innerHTML = '<span class="prog-none">No matching programs</span>';
    } else {
        programsArea.innerHTML = eligible.map(p => {
            const cls = p.status === 'Eligible' ? 'prog-badge-eligible' : 'prog-badge-potential';
            const beta = p.program_name === 'GMCC CRA: Diamond CRA' ? ' <span class="beta-tag">Beta</span>' : '';
            return `<span class="prog-badge ${cls}">${escapeHtml(p.program_name)}${beta}</span>`;
        }).join('');
    }
}

function renderCriteriaGrid(program) {
    const tier = program.matching_tiers.find(t => t.tier_name === program.best_tier) || program.matching_tiers[0];
    if (!tier) return '';

    const items = tier.criteria.map(criterion => {
        const icon = STATUS_ICONS[criterion.status] || STATUS_ICONS.unverified;
        const label = criterion.criterion.replace(/_/g, ' ');
        return `<div class="criterion-item">
            <span class="criterion-icon">${icon}</span>
            <div>
                <div class="criterion-label">${escapeHtml(label)}</div>
                <div class="criterion-detail">${escapeHtml(criterion.detail)}</div>
            </div>
        </div>`;
    }).join('');

    return `<div class="criteria-grid">${items}</div>`;
}

function createProgramCard(program, listing) {
    const card = document.createElement('div');
    card.className = 'program-card';

    const statusClass = program.status === 'Eligible' ? 'status-eligible' : 'status-potentially';
    const tierText = program.best_tier
        ? (program.best_tier.length > 50 ? program.best_tier.slice(0, 50) + '...' : program.best_tier)
        : '';

    const header = document.createElement('div');
    header.className = 'program-card-header';
    header.innerHTML = `
        <span class="program-name">${escapeHtml(program.program_name)}</span>
        <span class="program-status ${statusClass}">${escapeHtml(program.status)}</span>
        <span class="program-tier">${escapeHtml(tierText)}</span>
        <span class="program-chevron">&#9656;</span>
    `;

    const body = document.createElement('div');
    body.className = 'program-card-body';
    body.style.display = 'none';
    const betaNotice = program.program_name === 'GMCC CRA: Diamond CRA'
        ? `<div class="diamond-beta-notice">Beta — Tract eligibility list may be outdated. Please verify at <a href="https://hub.collateralanalytics.com/correspondentsearch" target="_blank" rel="noopener">Collateral Analytics</a> before proceeding.</div>`
        : '';

    body.innerHTML = `
        ${betaNotice}
        ${renderCriteriaGrid(program)}
        <button class="btn-talking-points" data-program="${escapeHtml(program.program_name)}" data-tier="${escapeHtml(program.best_tier || '')}">Get Talking Points</button>
        <div class="talking-points-content"></div>
    `;

    header.addEventListener('click', () => {
        const isExpanded = card.classList.toggle('expanded');
        body.style.display = isExpanded ? 'block' : 'none';
    });

    const tpBtn = body.querySelector('.btn-talking-points');
    const tpContent = body.querySelector('.talking-points-content');

    tpBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (listing._explanationCache && listing._explanationCache[program.program_name]) {
            tpContent.innerHTML = renderSimpleMarkdown(listing._explanationCache[program.program_name]);
            return;
        }
        tpBtn.disabled = true;
        tpBtn.innerHTML = 'Loading... <span class="btn-loader"></span>';
        try {
            const response = await fetch('/api/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    program_name: program.program_name,
                    listing: listing,
                    tier_name: program.best_tier || ''
                })
            });
            if (!response.ok) throw new Error(`Explain failed (${response.status})`);
            const data = await response.json();
            if (data.success) {
                listing._explanationCache = listing._explanationCache || {};
                listing._explanationCache[program.program_name] = data.explanation;
                tpContent.innerHTML = renderSimpleMarkdown(data.explanation);
            } else {
                tpContent.textContent = 'Unable to load talking points. Try again.';
            }
        } catch {
            tpContent.textContent = 'Unable to load talking points. Try again.';
        } finally {
            tpBtn.disabled = false;
            tpBtn.innerHTML = 'Get Talking Points';
        }
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
}

function showFilterBar() {
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.remove('hidden');
}

function configureFilterBarForTab() {
    // Show/hide the right filter groups based on activeTab
    const tractGroup = document.getElementById('tractFilterGroup');
    const advancedGroup = document.getElementById('advancedFilterGroup');
    const mkProgGroup = document.getElementById('mkProgramFilterGroup');
    const mkTypeGroup = document.getElementById('mkTypeFilterGroup');
    const sortByEl = document.getElementById('sortBy');

    tractGroup.style.display = 'none';
    advancedGroup.style.display = 'none';
    mkProgGroup.style.display = 'none';
    mkTypeGroup.style.display = 'none';
    sortByEl.parentElement && (sortByEl.style.display = '');
    // Also show/hide the Sort label (previous sibling)
    const sortLabel = sortByEl.previousElementSibling;

    if (activeTab === 'find') {
        tractGroup.style.display = '';
        sortByEl.style.display = '';
        if (sortLabel) sortLabel.style.display = '';
    } else if (activeTab === 'program') {
        advancedGroup.style.display = '';
        sortByEl.style.display = '';
        if (sortLabel) sortLabel.style.display = '';
    } else if (activeTab === 'marketing') {
        advancedGroup.style.display = '';
        mkProgGroup.style.display = '';
        mkTypeGroup.style.display = '';
        // Hide sort dropdown for marketing (uses table header sorting)
        sortByEl.style.display = 'none';
        if (sortLabel) sortLabel.style.display = 'none';
    }
}

function populateMkFilterDropdowns() {
    // Populate program filter from actual matched programs in results
    const progSelect = document.getElementById('mkProgramFilter');
    const currentProg = progSelect.value;
    const programNames = new Set();
    currentListings.forEach(listing => {
        const progs = listing.matchData?.programs || [];
        progs.forEach(p => {
            if (p.status !== 'Ineligible') programNames.add(p.program_name);
        });
    });
    progSelect.innerHTML = '<option value="">All Programs</option>';
    Array.from(programNames).sort().forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        progSelect.appendChild(opt);
    });
    if (currentProg && programNames.has(currentProg)) progSelect.value = currentProg;

    // Populate property type filter from actual listing types
    const typeSelect = document.getElementById('mkTypeFilter');
    const currentType = typeSelect.value;
    const types = new Set();
    currentListings.forEach(listing => {
        if (listing.propertyType) types.add(listing.propertyType);
    });
    typeSelect.innerHTML = '<option value="">All Types</option>';
    Array.from(types).sort().forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        typeSelect.appendChild(opt);
    });
    if (currentType && types.has(currentType)) typeSelect.value = currentType;
}

function getMatchScore(listing, activePrograms) {
    if (!listing.matchData) return 0;
    let score = 0;
    listing.matchData.programs.forEach(p => {
        if (activePrograms && !activePrograms.includes(p.program_name)) return;
        if (p.status === 'Eligible') score += 2;
        else if (p.status === 'Potentially Eligible') score += 1;
    });
    return score;
}

function getFilteredListings() {
    let listings = currentListings;

    // Apply pre-search program filter (selectedPrograms from the Programs dropdown)
    if (selectedPrograms.length > 0) {
        listings = listings.filter(listing => {
            if (!listing.matchData) return true;
            return listing.matchData.programs.some(p =>
                selectedPrograms.includes(p.program_name) && p.status !== 'Ineligible'
            );
        });
    }

    // Apply chip filters (tract filters for Find tab, advanced filters for Program tab)
    if (activeChipFilters.size > 0) {
        listings = listings.filter(l => listingPassesChipFilters(l, activeChipFilters));
    }

    // Sort
    const sortBy = document.getElementById('sortBy').value;
    listings = [...listings];
    switch (sortBy) {
        case 'price-asc':
            listings.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
            break;
        case 'price-desc':
            listings.sort((a, b) => (b.price || 0) - (a.price || 0));
            break;
        case 'days-asc':
            listings.sort((a, b) => (a.daysOnMarket ?? Infinity) - (b.daysOnMarket ?? Infinity));
            break;
        case 'days-desc':
            listings.sort((a, b) => (b.daysOnMarket ?? 0) - (a.daysOnMarket ?? 0));
            break;
        case 'best-match': {
            const activePrograms = selectedPrograms.length > 0 ? selectedPrograms : null;
            listings.sort((a, b) => getMatchScore(b, activePrograms) - getMatchScore(a, activePrograms));
            break;
        }
        case 'zipcode':
            listings.sort((a, b) => (a.zipCode || '').localeCompare(b.zipCode || ''));
            break;
        case 'address':
            listings.sort((a, b) => (a.formattedAddress || '').localeCompare(b.formattedAddress || ''));
            break;
        case 'distance':
        default:
            listings.sort((a, b) => (a.distance || 999) - (b.distance || 999));
            break;
    }

    return listings;
}

function renderFilteredPage() {
    if (activeTab === 'marketing') {
        renderMarketingPage();
        return;
    }
    const filtered = getFilteredListings();
    const grid = document.getElementById('resultsGrid');
    grid.innerHTML = '';

    const totalPages = Math.ceil(filtered.length / perPage);
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages || 1;

    const start = (currentPage - 1) * perPage;
    const end = Math.min(start + perPage, filtered.length);
    const pageListings = filtered.slice(start, end);

    pageListings.forEach(listing => {
        const index = currentListings.indexOf(listing);
        grid.appendChild(createPropertyCard(listing, index));
    });

    renderPagination(totalPages);

    const isFiltering = selectedPrograms.length > 0 || activeChipFilters.size > 0;
    if (isFiltering) {
        updateStats(filtered);
    }

    const summary = document.getElementById('filterSummary');
    if (isFiltering) {
        const matchedCount = currentListings.filter(l => l.matchData).length;
        const totalCount = currentListings.length;
        if (matchedCount < totalCount) {
            summary.textContent = `Showing ${filtered.length} verified matches (${totalCount - matchedCount} still checking...)`;
        } else {
            summary.textContent = `${filtered.length} of ${totalCount} properties match filters`;
        }
    } else {
        summary.textContent = '';
    }

    matchPageListings();
}

function resetMatching() {
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.add('hidden');
    const sortBy = document.getElementById('sortBy');
    if (sortBy) sortBy.value = 'distance';
    const summary = document.getElementById('filterSummary');
    if (summary) summary.textContent = '';
    resetChipFilters();
    mkProgramFilter = '';
    mkTypeFilter = '';
    const mkProgSel = document.getElementById('mkProgramFilter');
    if (mkProgSel) mkProgSel.value = '';
    const mkTypeSel = document.getElementById('mkTypeFilter');
    if (mkTypeSel) mkTypeSel.value = '';
    document.querySelectorAll('.property-card.hidden').forEach(c => c.classList.remove('hidden'));
}

// =============================================================================
// MSA / Census Panel
// =============================================================================

function demoPct(count, total) {
    if (count == null || !total) return '';
    return ` (${(count / total * 100).toFixed(0)}%)`;
}

function renderMsaPanel(censusData) {
    if (!censusData) {
        return `<div class="msa-panel msa-loading">
            <div class="msa-panel-title">MSA / Census Data</div>
            <p class="msa-unavailable">Census data unavailable for this property.</p>
        </div>`;
    }

    const incomeLevel = censusData.tract_income_level || 'N/A';
    const incomeLevelLower = incomeLevel.toLowerCase();
    const isLmi = ['low', 'moderate'].includes(incomeLevelLower);
    const incomeBadgeClass = isLmi ? 'msa-badge-lmi' : 'msa-badge-non-lmi';

    const minorityPct = censusData.tract_minority_pct;
    const isMMCT = minorityPct != null && minorityPct > 50;
    const mmctBadgeClass = isMMCT ? 'msa-badge-lmi' : 'msa-badge-non-lmi';

    const majorityAaHp = censusData.majority_aa_hp;
    const majorityText = majorityAaHp === true ? 'Yes' : majorityAaHp === false ? 'No' : 'N/A';

    const total = censusData.total_population;

    return `<div class="msa-panel">
        <div class="msa-panel-title">MSA / Census Tract Data
            <span class="msa-badge ${incomeBadgeClass}">${escapeHtml(incomeLevel)} Income</span>
            <span class="msa-badge ${mmctBadgeClass}">${isMMCT ? 'In-MMCT' : 'Not MMCT'}</span>
        </div>
        <div class="msa-grid">
            <div class="msa-item">
                <span class="msa-label">MSA/MD Code</span>
                <span class="msa-value">${escapeHtml(censusData.msa_code || 'N/A')}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">MSA Name</span>
                <span class="msa-value">${escapeHtml(censusData.msa_name || 'N/A')}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract Income Level</span>
                <span class="msa-value">${escapeHtml(incomeLevel)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract Minority %</span>
                <span class="msa-value">${formatPct(minorityPct)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Majority AA/HP</span>
                <span class="msa-value">${majorityText}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Total Population</span>
                <span class="msa-value">${formatNumber(total)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Hispanic Population</span>
                <span class="msa-value">${formatNumber(censusData.hispanic_population)}${demoPct(censusData.hispanic_population, total)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Black Population</span>
                <span class="msa-value">${formatNumber(censusData.black_population)}${demoPct(censusData.black_population, total)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Asian Population</span>
                <span class="msa-value">${formatNumber(censusData.asian_population)}${demoPct(censusData.asian_population, total)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">FFIEC MSA MFI</span>
                <span class="msa-value">${formatCurrency(censusData.ffiec_mfi)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract MFI</span>
                <span class="msa-value">${formatCurrency(censusData.tract_mfi)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract / MSA Ratio</span>
                <span class="msa-value">${censusData.tract_to_msa_ratio != null ? censusData.tract_to_msa_ratio.toFixed(1) + '%' : 'N/A'}</span>
            </div>
        </div>
    </div>`;
}

// =============================================================================
// UI
// =============================================================================

function showLoading(show) {
    const btn = document.getElementById('searchBtn');
    btn.disabled = show;
    btn.querySelector('.btn-text').textContent = show ? 'Searching...' : 'Search';
    btn.querySelector('.btn-loader').style.display = show ? 'block' : 'none';
}

function showError(message) {
    const banner = document.getElementById('errorBanner');
    document.getElementById('errorText').textContent = message;
    banner.style.display = 'block';
    setTimeout(() => { banner.style.display = 'none'; }, 5000);
}

function hideError() {
    document.getElementById('errorBanner').style.display = 'none';
}

function showMessage(message) {
    const banner = document.getElementById('messageBanner');
    const text = document.getElementById('messageText');
    if (message) { text.textContent = message; banner.style.display = 'block'; }
    else banner.style.display = 'none';
}

function updateStats(listings) {
    const prices = listings.map(l => l.price).filter(p => p != null);
    const days = listings.map(l => l.daysOnMarket).filter(d => d != null);

    document.getElementById('statCount').textContent = listings.length;

    if (prices.length > 0) {
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        document.getElementById('statAvgPrice').textContent = formatPrice(avg);
        document.getElementById('statPriceRange').textContent =
            `${formatPrice(Math.min(...prices))} – ${formatPrice(Math.max(...prices))}`;
    } else {
        document.getElementById('statAvgPrice').textContent = '-';
        document.getElementById('statPriceRange').textContent = '-';
    }

    if (days.length > 0) {
        const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
        document.getElementById('statAvgDays').textContent = `${avg} days`;
    } else {
        document.getElementById('statAvgDays').textContent = '-';
    }
}

function createPropertyCard(listing, index) {
    const card = document.createElement('div');
    card.className = 'property-card';
    card.setAttribute('data-index', index);

    const price = formatPrice(listing.price);
    const address = listing.formattedAddress || 'Address not available';
    const days = listing.daysOnMarket != null ? listing.daysOnMarket : 'N/A';
    const propertyType = listing.propertyType || 'Unknown';
    const distance = formatDistance(listing.distance);

    // Render match badges if data already loaded, otherwise show loading skeleton
    let programsHtml;
    if (listing.matchData) {
        const eligible = listing.matchData.programs.filter(p => p.status !== 'Ineligible');
        if (eligible.length === 0) {
            programsHtml = '<span class="prog-none">No matching programs</span>';
        } else {
            programsHtml = eligible.map(p => {
                const cls = p.status === 'Eligible' ? 'prog-badge-eligible' : 'prog-badge-potential';
                const beta = p.program_name === 'GMCC CRA: Diamond CRA' ? ' <span class="beta-tag">Beta</span>' : '';
                return `<span class="prog-badge ${cls}">${escapeHtml(p.program_name)}${beta}</span>`;
            }).join('');
        }
    } else {
        programsHtml = '<span class="prog-badge prog-badge-loading">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>';
    }

    card.innerHTML = `
        <div class="property-card-content">
            <div class="property-price">${price}</div>
            <div class="property-address">${escapeHtml(address)}</div>
            <div class="property-badges">
                <span class="badge badge-days">${escapeHtml(String(days))} days on market</span>
                <span class="badge badge-type">${escapeHtml(propertyType)}</span>
            </div>
            <div class="card-programs-section">
                <div class="card-programs-label">Matched Programs</div>
                <div class="card-programs">${programsHtml}</div>
            </div>
        </div>
        ${distance ? `<div class="property-distance">${distance}</div>` : ''}
    `;

    card.addEventListener('click', () => openPropertyModal(listing));
    return card;
}

function renderListings(listings) {
    const grid = document.getElementById('resultsGrid');
    const noResults = document.getElementById('noResults');
    const resultsSection = document.getElementById('resultsSection');
    const pagination = document.getElementById('pagination');

    grid.innerHTML = '';

    if (listings.length === 0) {
        noResults.style.display = 'block';
        grid.style.display = 'none';
        document.getElementById('statsBar').style.display = 'none';
        pagination.style.display = 'none';
    } else {
        noResults.style.display = 'none';
        grid.style.display = 'grid';
        document.getElementById('statsBar').style.display = 'grid';
        updateStats(listings);
        renderPage();
    }

    resultsSection.style.display = 'block';
}

function renderPage() {
    renderFilteredPage();
    window.scrollTo({ top: document.getElementById('resultsSection').offsetTop - 80, behavior: 'smooth' });
}

function renderPagination(totalPages) {
    const pagination = document.getElementById('pagination');
    const pagesContainer = document.getElementById('paginationPages');
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');

    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }

    pagination.style.display = 'flex';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    // Build page numbers with ellipsis for large sets
    pagesContainer.innerHTML = '';
    const pages = [];
    if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
        pages.push(1);
        if (currentPage > 3) pages.push('...');
        for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
            pages.push(i);
        }
        if (currentPage < totalPages - 2) pages.push('...');
        pages.push(totalPages);
    }

    pages.forEach(p => {
        if (p === '...') {
            const span = document.createElement('span');
            span.className = 'pagination-ellipsis';
            span.textContent = '...';
            pagesContainer.appendChild(span);
        } else {
            const btn = document.createElement('button');
            btn.className = 'pagination-page' + (p === currentPage ? ' active' : '');
            btn.textContent = p;
            btn.addEventListener('click', () => { currentPage = p; renderPage(); });
            pagesContainer.appendChild(btn);
        }
    });
}

// =============================================================================
// Modal
// =============================================================================

function openPropertyModal(listing) {
    currentModalListing = listing;
    const modal = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');

    const agent = listing.listingAgent || {};
    const builder = listing.builder || {};
    const office = listing.listingOffice || {};
    const hoa = listing.hoa || {};

    let contactHtml = '';
    if (agent.name || agent.phone || agent.email) {
        contactHtml = `<div class="modal-contact">
            <div class="modal-contact-name">${escapeHtml(agent.name) || 'Agent name not available'}</div>
            <div class="modal-contact-info">
                ${agent.phone ? `Phone: ${formatPhone(agent.phone)}<br>` : ''}
                ${agent.email ? `Email: ${escapeHtml(agent.email)}<br>` : ''}
                ${agent.website ? `Website: <a href="${escapeHtml(agent.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(agent.website)}</a>` : ''}
            </div>
        </div>`;
    } else if (builder.name) {
        contactHtml = `<div class="modal-contact">
            <div class="modal-contact-name">${escapeHtml(builder.name)} (Builder)</div>
            <div class="modal-contact-info">
                ${builder.phone ? `Phone: ${formatPhone(builder.phone)}<br>` : ''}
                ${builder.development ? `Development: ${escapeHtml(builder.development)}<br>` : ''}
                ${builder.website ? `Website: <a href="${escapeHtml(builder.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(builder.website)}</a>` : ''}
            </div>
        </div>`;
    } else {
        contactHtml = `<div class="modal-contact"><div class="modal-contact-info">No contact information available</div></div>`;
    }

    // MSA panel — use census data if already loaded, else show loading state
    const censusData = listing.censusData || (listing.matchData ? listing.matchData.census_data : null);

    content.innerHTML = `
        <div class="modal-header">
            <div class="modal-price">${formatPrice(listing.price)}</div>
            <div class="modal-address">${escapeHtml(listing.formattedAddress || 'Address not available')}</div>
        </div>

        <!-- MSA / Census Section -->
        <div class="modal-section">
            ${listing.matchLoading
                ? '<div class="msa-panel"><div class="msa-panel-title">MSA / Census Data</div><p class="msa-unavailable">Loading census data...</p></div>'
                : renderMsaPanel(censusData)
            }
        </div>

        <!-- Matching Programs Section -->
        <div class="modal-section" id="modalProgramsSection">
            <div class="modal-section-title">Matching Programs</div>
            <div id="programCardsContainer">
                ${listing.matchLoading ? '<div class="programs-loading">Loading program matches...</div>' : ''}
                ${!listing.matchData && !listing.matchLoading ? '<div class="programs-empty">Match data not yet available.</div>' : ''}
                ${listing.matchData && listing.matchData.programs.filter(p => p.status !== 'Ineligible').length === 0 && !listing.matchLoading ? '<div class="programs-empty">No matching GMCC programs found for this property.</div>' : ''}
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Property Details</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-item-label">Type</span>
                    <span class="modal-item-value">${escapeHtml(listing.propertyType || 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Bedrooms</span>
                    <span class="modal-item-value">${escapeHtml(String(listing.bedrooms || 'N/A'))}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Bathrooms</span>
                    <span class="modal-item-value">${escapeHtml(String(listing.bathrooms || 'N/A'))}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Square Footage</span>
                    <span class="modal-item-value">${listing.squareFootage ? listing.squareFootage.toLocaleString() + ' sq ft' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Lot Size</span>
                    <span class="modal-item-value">${listing.lotSize ? listing.lotSize.toLocaleString() + ' sq ft' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Year Built</span>
                    <span class="modal-item-value">${listing.yearBuilt || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">HOA Fee</span>
                    <span class="modal-item-value">${hoa.fee ? '$' + hoa.fee.toLocaleString() + '/mo' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Status</span>
                    <span class="modal-item-value">${escapeHtml(listing.status || 'N/A')}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Listing Information</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-item-label">Listed Date</span>
                    <span class="modal-item-value">${escapeHtml(listing.listedDate ? listing.listedDate.slice(0, 10) : 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Days on Market</span>
                    <span class="modal-item-value">${listing.daysOnMarket != null ? escapeHtml(String(listing.daysOnMarket)) + ' days' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">MLS Number</span>
                    <span class="modal-item-value">${escapeHtml(listing.mlsNumber || 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Last Updated</span>
                    <span class="modal-item-value">${escapeHtml(listing.lastSeenDate ? listing.lastSeenDate.slice(0, 10) : 'N/A')}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Location</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-item-label">City</span>
                    <span class="modal-item-value">${escapeHtml(listing.city || 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">State</span>
                    <span class="modal-item-value">${escapeHtml(listing.state || 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Zip Code</span>
                    <span class="modal-item-value">${escapeHtml(listing.zipCode || 'N/A')}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">County</span>
                    <span class="modal-item-value">${escapeHtml(listing.county || 'N/A')}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Contact Information</div>
            ${contactHtml}
            ${office.name ? `<div class="modal-contact" style="margin-top:0.75rem;">
                <div class="modal-contact-name">${escapeHtml(office.name)} (Office)</div>
                <div class="modal-contact-info">
                    ${office.phone ? `Phone: ${formatPhone(office.phone)}<br>` : ''}
                    ${office.email ? `Email: ${escapeHtml(office.email)}` : ''}
                </div>
            </div>` : ''}
        </div>
    `;

    // Append program cards
    if (listing.matchData) {
        const container = document.getElementById('programCardsContainer');
        const matched = listing.matchData.programs.filter(p => p.status !== 'Ineligible');
        matched.forEach(program => container.appendChild(createProgramCard(program, listing)));
    }

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    currentModalListing = null;
    document.getElementById('modalOverlay').style.display = 'none';
    document.body.style.overflow = '';
}

function refreshModalIfOpen(listing) {
    if (currentModalListing === listing && document.getElementById('modalOverlay').style.display === 'flex') {
        openPropertyModal(listing);
    }
}

// =============================================================================
// Event Handlers
// =============================================================================

async function handleSearch(e) {
    e.preventDefault();

    let query = document.getElementById('searchQuery').value.trim();
    const radius = document.getElementById('radius').value;
    const searchType = document.getElementById('searchType').value;

    if (!query) { showError('Please enter a search location.'); return; }

    hideError();
    showMessage(null);
    resetMatching();
    currentPage = 1;
    perPage = parseInt(document.getElementById('perPage').value, 10) || 10;
    showLoading(true);

    try {
        const result = await searchListings(query, radius, searchType);
        if (result.success) {
            currentListings = result.listings;
            renderListings(result.listings);
            showFilterBar();
            configureFilterBarForTab();
            if (result.message) showMessage(result.message);
        } else {
            showError(result.error || 'An error occurred while searching.');
            document.getElementById('resultsSection').style.display = 'none';
        }
    } catch (error) {
        if (error.name === 'AbortError') return; // stale request cancelled
        showError('Failed to connect to the server. Please try again.');
        document.getElementById('resultsSection').style.display = 'none';
    } finally {
        showLoading(false);
    }
}

function handleSearchTypeChange() {
    const searchType = document.getElementById('searchType').value;
    const radiusGroup = document.getElementById('radiusGroup');
    radiusGroup.style.opacity = searchType === 'specific' ? '0.5' : '1';
    radiusGroup.style.pointerEvents = searchType === 'specific' ? 'none' : 'auto';

    // Toggle map radius circle based on search type
    if (window._searchMapCircle) {
        window._searchMapCircle.setMap(null);
        window._searchMapCircle = null;
    }
    if (searchType === 'area') {
        updateMapCircle();
    }
}

function handleRadiusChange() {
    document.getElementById('radiusValue').textContent = document.getElementById('radius').value;
}

// =============================================================================
// Program Pre-Filter Selector
// =============================================================================

async function initProgramSelector() {
    try {
        const resp = await fetch('/api/programs');
        if (!resp.ok) throw new Error('programs fetch failed');
        const data = await resp.json();
        availablePrograms = data.programs || [];
    } catch {
        availablePrograms = [];
    }

    const dropdown = document.getElementById('programSelectDropdown');
    if (!dropdown || !availablePrograms.length) return;

    dropdown.innerHTML = availablePrograms.map((name, i) =>
        `<div class="program-select-item">
            <input type="checkbox" id="progCheck${i}" value="${escapeHtml(name)}">
            <label for="progCheck${i}">${escapeHtml(name)}</label>
        </div>`
    ).join('') + '<button class="program-select-clear" id="programSelectClear">Clear All</button>';

    // Toggle dropdown
    const toggle = document.getElementById('programSelectToggle');
    const container = document.getElementById('programSelect');

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        container.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
        }
    });

    // Checkbox changes
    dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updateSelectedPrograms);
    });

    // Clear button
    document.getElementById('programSelectClear').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        updateSelectedPrograms();
    });
}

function updateSelectedPrograms() {
    const dropdown = document.getElementById('programSelectDropdown');
    const checked = dropdown.querySelectorAll('input[type="checkbox"]:checked');
    selectedPrograms = Array.from(checked).map(cb => cb.value);

    const label = document.getElementById('programSelectLabel');
    if (selectedPrograms.length === 0) {
        label.textContent = 'All Programs';
    } else if (selectedPrograms.length === 1) {
        label.textContent = selectedPrograms[0];
    } else {
        label.textContent = `${selectedPrograms.length} programs selected`;
    }
}

function getSelectedProgramsParam() {
    return selectedPrograms.length > 0 ? selectedPrograms.join(',') : '';
}

// =============================================================================
// Map Widget (Google Maps)
// =============================================================================

window._searchMap = null;
window._searchMapMarker = null;
window._searchMapCircle = null;

async function initMap() {
    try {
        const resp = await fetch('/api/maps-key');
        if (!resp.ok) return;
        const config = await resp.json();
        const apiKey = config.key;
        if (!apiKey) return;

        // Load Google Maps JS SDK (async loading pattern)
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=marker&loading=async&callback=onMapsReady`;
        script.async = true;
        document.head.appendChild(script);
    } catch {
        // Maps not available — silently degrade
    }
}

function onMapsReady() {
    const mapContainer = document.getElementById('mapContainer');
    mapContainer.style.display = 'block';

    // Default center: continental US
    const defaultCenter = { lat: 39.8283, lng: -98.5795 };

    const map = new google.maps.Map(document.getElementById('searchMap'), {
        center: defaultCenter,
        zoom: 4,
        mapId: 'gmcc_search_map',
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: true,
    });

    window._searchMap = map;

    // Click on map to set search location
    map.addListener('click', (e) => {
        const lat = e.latLng.lat();
        const lng = e.latLng.lng();
        placeMapMarker(lat, lng);
        reverseGeocode(lat, lng);
    });

    // Sync radius slider with map circle
    document.getElementById('radius').addEventListener('input', () => {
        updateMapCircle();
    });
}

function placeMapMarker(lat, lng) {
    const map = window._searchMap;
    if (!map) return;

    // Remove existing marker
    if (window._searchMapMarker) {
        window._searchMapMarker.map = null;
    }

    window._searchMapMarker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat, lng },
        map: map,
        gmpDraggable: true,
    });

    // Drag end → update search query
    window._searchMapMarker.addListener('dragend', () => {
        const pos = window._searchMapMarker.position;
        reverseGeocode(pos.lat, pos.lng);
        updateMapCircle();
    });

    map.panTo({ lat, lng });
    if (map.getZoom() < 10) map.setZoom(12);

    updateMapCircle();
}

function updateMapCircle() {
    const marker = window._searchMapMarker;
    const map = window._searchMap;
    if (!marker || !map) return;

    const radiusMiles = parseFloat(document.getElementById('radius').value);
    const radiusMeters = radiusMiles * 1609.34;

    if (window._searchMapCircle) {
        window._searchMapCircle.setMap(null);
    }

    const searchType = document.getElementById('searchType').value;
    if (searchType === 'specific') return; // No circle for exact address

    window._searchMapCircle = new google.maps.Circle({
        map: map,
        center: marker.position,
        radius: radiusMeters,
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        strokeColor: '#3b82f6',
        strokeOpacity: 0.3,
        strokeWeight: 1,
        clickable: false
    });
}

function reverseGeocode(lat, lng) {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === 'OK' && results[0]) {
            const input = document.getElementById('searchQuery');
            const addr = results[0].formatted_address.replace(/,\s*USA$/, '');
            input.value = addr;
        }
    });
}

function geocodeAndMoveMap(address) {
    if (!window._searchMap) return;
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: address }, (results, status) => {
        if (status === 'OK' && results[0]) {
            const loc = results[0].geometry.location;
            placeMapMarker(loc.lat(), loc.lng());
        }
    });
}

// Make callback globally accessible for Google Maps SDK
window.onMapsReady = onMapsReady;

// =============================================================================
// Tab Switching
// =============================================================================

function switchTab(tab) {
    activeTab = tab;

    // Update tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update tab content
    const tabMap = { find: 'tabFind', program: 'tabProgram', marketing: 'tabMarketing' };
    Object.entries(tabMap).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = key === tab ? 'block' : 'none';
        el.classList.toggle('active', key === tab);
    });

    // Reset results when switching tabs
    document.getElementById('resultsSection').style.display = 'none';
    currentListings = [];
    currentPage = 1;
    mkSortColumn = 'price';
    mkSortDirection = 'desc';
    resetMatching();
    showMessage(null);
    hideError();
}

// =============================================================================
// Program Search Tab
// =============================================================================

async function initProgramSearch() {
    try {
        const resp = await fetch('/api/program-locations');
        if (!resp.ok) throw new Error('program-locations fetch failed');
        const data = await resp.json();
        programLocations = data.programs || [];
    } catch {
        programLocations = [];
    }

    const select = document.getElementById('psProgram');
    select.innerHTML = '<option value="">Select a program...</option>';
    programLocations.forEach(p => {
        if (!p.states || p.states.length === 0) return;
        const opt = document.createElement('option');
        opt.value = p.program_name;
        opt.textContent = p.program_name;
        select.appendChild(opt);
    });
}

function onPsProgramChange() {
    const programName = document.getElementById('psProgram').value;
    const stateSelect = document.getElementById('psState');
    const countySelect = document.getElementById('psCounty');
    const citySelect = document.getElementById('psCity');

    // Reset downstream
    stateSelect.innerHTML = '<option value="">Select state...</option>';
    countySelect.innerHTML = '<option value="">Select county...</option>';
    citySelect.innerHTML = '<option value="">Entire county</option>';
    stateSelect.disabled = true;
    countySelect.disabled = true;
    citySelect.disabled = true;

    if (!programName) return;

    const program = programLocations.find(p => p.program_name === programName);
    if (!program) return;

    program.states.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.state;
        opt.textContent = s.state;
        stateSelect.appendChild(opt);
    });
    stateSelect.disabled = false;
}

function onPsStateChange() {
    const programName = document.getElementById('psProgram').value;
    const stateName = document.getElementById('psState').value;
    const countySelect = document.getElementById('psCounty');
    const citySelect = document.getElementById('psCity');

    countySelect.innerHTML = '<option value="">Select county...</option>';
    citySelect.innerHTML = '<option value="">Entire county</option>';
    countySelect.disabled = true;
    citySelect.disabled = true;

    if (!programName || !stateName) return;

    const program = programLocations.find(p => p.program_name === programName);
    if (!program) return;

    const stateData = program.states.find(s => s.state === stateName);
    if (!stateData) return;

    stateData.counties.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.fips;
        opt.textContent = c.county;
        countySelect.appendChild(opt);
    });
    countySelect.disabled = false;
}

function onPsCountyChange() {
    const programName = document.getElementById('psProgram').value;
    const stateName = document.getElementById('psState').value;
    const countyFips = document.getElementById('psCounty').value;
    const citySelect = document.getElementById('psCity');

    citySelect.innerHTML = '<option value="">Entire county</option>';
    citySelect.disabled = true;

    if (!programName || !stateName || !countyFips) return;

    const program = programLocations.find(p => p.program_name === programName);
    if (!program) return;
    const stateData = program.states.find(s => s.state === stateName);
    if (!stateData) return;
    const county = stateData.counties.find(c => c.fips === countyFips);
    if (!county || !county.cities || county.cities.length === 0) return;

    county.cities.forEach(city => {
        const opt = document.createElement('option');
        opt.value = city;
        opt.textContent = city;
        citySelect.appendChild(opt);
    });
    citySelect.disabled = false;
}

async function handleProgramSearch(e) {
    e.preventDefault();

    const programName = document.getElementById('psProgram').value;
    const countyFips = document.getElementById('psCounty').value;
    const city = document.getElementById('psCity').value;

    if (!programName) { showError('Please select a program.'); return; }
    if (!countyFips) { showError('Please select a county.'); return; }

    hideError();
    showMessage(null);
    resetMatching();
    currentPage = 1;
    perPage = 10;

    const btn = document.getElementById('psSearchBtn');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Searching...';
    btn.querySelector('.btn-loader').style.display = 'block';

    try {
        const params = new URLSearchParams({ program: programName, county_fips: countyFips });
        if (city) params.set('city', city);

        const resp = await fetch(`/api/program-search?${params}`);
        if (!resp.ok) throw new Error(`Program search failed (${resp.status})`);
        const data = await resp.json();

        if (data.success) {
            currentListings = data.listings || [];

            if (currentListings.length === 0) {
                showMessage(`No matching properties found. Searched ${data.total_searched} listings in this area.`);
            }

            // Set default sort to best-match for program search
            document.getElementById('sortBy').value = 'best-match';
            renderListings(currentListings);
            showFilterBar();
            configureFilterBarForTab();
        } else {
            showError(data.error || 'Search failed.');
            document.getElementById('resultsSection').style.display = 'none';
        }
    } catch (error) {
        showError('Failed to connect to the server. Please try again.');
        document.getElementById('resultsSection').style.display = 'none';
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'Search';
        btn.querySelector('.btn-loader').style.display = 'none';
    }
}

// =============================================================================
// Massive Marketing City Check Tab
// =============================================================================

function getAggregatedLocations() {
    if (mkAggregated) return mkAggregated;
    const stateMap = {};
    programLocations.forEach(program => {
        (program.states || []).forEach(s => {
            if (!stateMap[s.state]) stateMap[s.state] = {};
            s.counties.forEach(c => {
                if (!stateMap[s.state][c.fips]) {
                    stateMap[s.state][c.fips] = { fips: c.fips, county: c.county, cities: new Set() };
                }
                (c.cities || []).forEach(city => stateMap[s.state][c.fips].cities.add(city));
            });
        });
    });
    mkAggregated = Object.keys(stateMap).sort().map(state => ({
        state,
        counties: Object.values(stateMap[state]).map(c => ({
            fips: c.fips,
            county: c.county,
            cities: Array.from(c.cities).sort()
        })).sort((a, b) => a.county.localeCompare(b.county))
    }));
    return mkAggregated;
}

function initMarketingTab() {
    const locations = getAggregatedLocations();
    const stateSelect = document.getElementById('mkState');
    stateSelect.innerHTML = '<option value="">Select state...</option>';
    locations.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.state;
        opt.textContent = s.state;
        stateSelect.appendChild(opt);
    });
}

function onMkStateChange() {
    const stateName = document.getElementById('mkState').value;
    const countySelect = document.getElementById('mkCounty');
    const citySelect = document.getElementById('mkCity');

    countySelect.innerHTML = '<option value="">Select county...</option>';
    citySelect.innerHTML = '<option value="">Entire county</option>';
    countySelect.disabled = true;
    citySelect.disabled = true;

    if (!stateName) return;

    const locations = getAggregatedLocations();
    const stateData = locations.find(s => s.state === stateName);
    if (!stateData) return;

    stateData.counties.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.fips;
        opt.textContent = c.county;
        countySelect.appendChild(opt);
    });
    countySelect.disabled = false;
}

function onMkCountyChange() {
    const stateName = document.getElementById('mkState').value;
    const countyFips = document.getElementById('mkCounty').value;
    const citySelect = document.getElementById('mkCity');

    citySelect.innerHTML = '<option value="">Entire county</option>';
    citySelect.disabled = true;

    if (!stateName || !countyFips) return;

    const locations = getAggregatedLocations();
    const stateData = locations.find(s => s.state === stateName);
    if (!stateData) return;
    const county = stateData.counties.find(c => c.fips === countyFips);
    if (!county || !county.cities || county.cities.length === 0) return;

    county.cities.forEach(city => {
        const opt = document.createElement('option');
        opt.value = city;
        opt.textContent = city;
        citySelect.appendChild(opt);
    });
    citySelect.disabled = false;
}

async function handleMarketingSearch(e) {
    e.preventDefault();

    const countyFips = document.getElementById('mkCounty').value;
    const city = document.getElementById('mkCity').value;

    if (!countyFips) { showError('Please select a county.'); return; }

    hideError();
    showMessage(null);
    resetMatching();
    currentPage = 1;
    perPage = 50; // larger default for marketing table
    mkSortColumn = 'price';
    mkSortDirection = 'desc';

    const btn = document.getElementById('mkSearchBtn');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Searching...';
    btn.querySelector('.btn-loader').style.display = 'block';

    try {
        const params = new URLSearchParams({ county_fips: countyFips });
        if (city) params.set('city', city);

        const resp = await fetch(`/api/marketing-search?${params}`);
        if (!resp.ok) throw new Error(`Marketing search failed (${resp.status})`);
        const data = await resp.json();

        if (data.success) {
            currentListings = data.listings || [];

            if (currentListings.length === 0) {
                showMessage(`No properties found. ${data.total_found} listings returned from API, ${data.total_in_county} in this county.`);
            }

            renderMarketingResults();
        } else {
            showError(data.error || 'Search failed.');
            document.getElementById('resultsSection').style.display = 'none';
        }
    } catch (error) {
        showError('Failed to connect to the server. Please try again.');
        document.getElementById('resultsSection').style.display = 'none';
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'Search';
        btn.querySelector('.btn-loader').style.display = 'none';
    }
}

function renderMarketingResults() {
    const resultsSection = document.getElementById('resultsSection');
    const noResults = document.getElementById('noResults');
    const grid = document.getElementById('resultsGrid');
    const pagination = document.getElementById('pagination');

    if (currentListings.length === 0) {
        noResults.style.display = 'block';
        grid.style.display = 'none';
        document.getElementById('statsBar').style.display = 'grid';
        updateStats(currentListings);
        pagination.style.display = 'none';
        resultsSection.style.display = 'block';
        return;
    }

    noResults.style.display = 'none';
    grid.style.display = 'block';
    document.getElementById('statsBar').style.display = 'grid';
    updateStats(currentListings);
    // Show filter bar with marketing-specific filters
    showFilterBar();
    configureFilterBarForTab();
    populateMkFilterDropdowns();

    renderMarketingPage();
    resultsSection.style.display = 'block';
}

function getMkSortValue(listing, key) {
    const census = listing.censusData || {};
    const agent = listing.listingAgent || {};
    switch (key) {
        case 'msa': return census.msa_code || '';
        case 'price': return listing.price || 0;
        case 'address': return listing.formattedAddress || '';
        case 'programs': {
            const progs = listing.matchData?.programs || [];
            return progs.filter(p => p.status !== 'Ineligible').length;
        }
        case 'mmct': return census.tract_minority_pct != null && census.tract_minority_pct > 50 ? 1 : 0;
        case 'lmi': {
            const level = (census.tract_income_level || '').toLowerCase();
            return { low: 0, moderate: 1, middle: 2, upper: 3 }[level] ?? 4;
        }
        case 'days': return listing.daysOnMarket ?? 9999;
        case 'agentName': return (agent.name || '').toLowerCase();
        case 'agentEmail': return (agent.email || '').toLowerCase();
        case 'agentPhone': return agent.phone || '';
        case 'state': return listing.state || '';
        case 'county': return listing.county || '';
        case 'city': return listing.city || '';
        case 'zip': return listing.zipCode || '';
        case 'type': return listing.propertyType || '';
        default: return '';
    }
}

function renderMarketingPage() {
    const grid = document.getElementById('resultsGrid');

    // Apply filters
    let filtered = currentListings;

    // Chip filters (MMCT, LMI, AA/HP, price ranges)
    if (activeChipFilters.size > 0) {
        filtered = filtered.filter(l => listingPassesChipFilters(l, activeChipFilters));
    }

    // Program filter dropdown
    mkProgramFilter = document.getElementById('mkProgramFilter').value;
    if (mkProgramFilter) {
        filtered = filtered.filter(listing => {
            const progs = listing.matchData?.programs || [];
            return progs.some(p => p.program_name === mkProgramFilter && p.status !== 'Ineligible');
        });
    }

    // Property type filter dropdown
    mkTypeFilter = document.getElementById('mkTypeFilter').value;
    if (mkTypeFilter) {
        filtered = filtered.filter(l => l.propertyType === mkTypeFilter);
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
        const va = getMkSortValue(a, mkSortColumn);
        const vb = getMkSortValue(b, mkSortColumn);
        let cmp;
        if (typeof va === 'number' && typeof vb === 'number') {
            cmp = va - vb;
        } else {
            cmp = String(va).localeCompare(String(vb));
        }
        return mkSortDirection === 'asc' ? cmp : -cmp;
    });

    // Pagination
    const totalPages = Math.ceil(sorted.length / perPage);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    const start = (currentPage - 1) * perPage;
    const end = Math.min(start + perPage, sorted.length);
    const pageListings = sorted.slice(start, end);

    // Column definitions
    const columns = [
        { key: 'msa', label: 'MSA #' },
        { key: 'price', label: 'Price' },
        { key: 'address', label: 'Active Listing Address' },
        { key: 'programs', label: 'Matched Programs' },
        { key: 'mmct', label: 'MMCT' },
        { key: 'lmi', label: 'Income Level' },
        { key: 'days', label: 'Days on Market' },
        { key: 'agentName', label: 'Agent' },
        { key: 'agentEmail', label: 'Email' },
        { key: 'agentPhone', label: 'Phone' },
        { key: 'state', label: 'State' },
        { key: 'county', label: 'County' },
        { key: 'city', label: 'City' },
        { key: 'zip', label: 'Zip' },
        { key: 'type', label: 'Type' },
    ];

    const headerHtml = columns.map(col => {
        const isActive = mkSortColumn === col.key;
        const arrow = isActive ? (mkSortDirection === 'asc' ? '&#9650;' : '&#9660;') : '&#8597;';
        return `<th class="sortable${isActive ? ' sort-active' : ''}" data-sort-key="${col.key}">${col.label}<span class="sort-arrow">${arrow}</span></th>`;
    }).join('');

    const rowsHtml = pageListings.map(listing => {
        const census = listing.censusData || {};
        const agent = listing.listingAgent || {};
        const programs = listing.matchData?.programs || [];
        const eligible = programs.filter(p => p.status !== 'Ineligible');

        const mmctStatus = census.tract_minority_pct != null && census.tract_minority_pct > 50;
        const incomeLevel = census.tract_income_level || 'N/A';
        const isLmi = incomeLevel && ['low', 'moderate'].includes(incomeLevel.toLowerCase());

        const programBadges = eligible.length > 0
            ? eligible.map(p => {
                const cls = p.status === 'Eligible' ? 'prog-badge-eligible' : 'prog-badge-potential';
                const beta = p.program_name === 'GMCC CRA: Diamond CRA' ? ' <span class="beta-tag">Beta</span>' : '';
                return `<span class="prog-badge ${cls}">${escapeHtml(p.program_name)}${beta}</span>`;
            }).join(' ')
            : '<span class="prog-none">None</span>';

        const idx = currentListings.indexOf(listing);

        return `<tr data-index="${idx}">
            <td>${escapeHtml(census.msa_code || 'N/A')}</td>
            <td>${formatPrice(listing.price)}</td>
            <td class="td-address" title="${escapeHtml(listing.formattedAddress || '')}">${escapeHtml(listing.formattedAddress || 'N/A')}</td>
            <td class="td-programs">${programBadges}</td>
            <td><span class="mk-badge ${mmctStatus ? 'mk-badge-yes' : 'mk-badge-no'}">${mmctStatus ? 'Yes' : 'No'}</span></td>
            <td><span class="mk-badge ${isLmi ? 'mk-badge-lmi' : 'mk-badge-non-lmi'}">${escapeHtml(incomeLevel)}</span></td>
            <td>${listing.daysOnMarket != null ? listing.daysOnMarket : 'N/A'}</td>
            <td>${escapeHtml(agent.name || 'N/A')}</td>
            <td>${escapeHtml(agent.email || 'N/A')}</td>
            <td>${agent.phone ? formatPhone(agent.phone) : 'N/A'}</td>
            <td>${escapeHtml(listing.state || 'N/A')}</td>
            <td>${escapeHtml(listing.county || 'N/A')}</td>
            <td>${escapeHtml(listing.city || 'N/A')}</td>
            <td>${escapeHtml(listing.zipCode || 'N/A')}</td>
            <td>${escapeHtml(listing.propertyType || 'N/A')}</td>
        </tr>`;
    }).join('');

    // Marketing summary (based on filtered results)
    const eligibleCount = filtered.filter(l => {
        const progs = l.matchData?.programs || [];
        return progs.some(p => p.status === 'Eligible');
    }).length;
    const potentialCount = filtered.filter(l => {
        const progs = l.matchData?.programs || [];
        return !progs.some(p => p.status === 'Eligible') && progs.some(p => p.status === 'Potentially Eligible');
    }).length;
    const hasFilters = activeChipFilters.size > 0 || mkProgramFilter || mkTypeFilter;
    const countLabel = hasFilters
        ? `<strong>${filtered.length}</strong> of ${currentListings.length} properties`
        : `<strong>${filtered.length}</strong> properties`;

    grid.innerHTML = `
        <div class="marketing-summary">
            <span>${countLabel}</span>
            <span><strong>${eligibleCount}</strong> eligible</span>
            <span><strong>${potentialCount}</strong> potentially eligible</span>
            <span><strong>${filtered.length - eligibleCount - potentialCount}</strong> no match</span>
        </div>
        <div class="marketing-table-wrapper">
            <table class="marketing-table">
                <thead><tr>${headerHtml}</tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;

    // Attach row click listeners
    grid.querySelectorAll('tr[data-index]').forEach(row => {
        row.addEventListener('click', () => {
            const idx = parseInt(row.dataset.index);
            openPropertyModal(currentListings[idx]);
        });
    });

    // Attach column header sort listeners
    grid.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sortKey;
            if (mkSortColumn === key) {
                mkSortDirection = mkSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                mkSortColumn = key;
                mkSortDirection = 'asc';
            }
            currentPage = 1;
            renderMarketingPage();
        });
    });

    renderPagination(totalPages);
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('searchForm').addEventListener('submit', handleSearch);
    document.getElementById('searchType').addEventListener('change', handleSearchTypeChange);
    document.getElementById('radius').addEventListener('input', handleRadiusChange);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', e => {
        if (e.target === document.getElementById('modalOverlay')) closeModal();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    document.getElementById('sortBy').addEventListener('change', () => { currentPage = 1; renderFilteredPage(); });

    // Chip filter listeners for both filter groups
    initChipFilterListeners('tractFilters');
    initChipFilterListeners('advancedFilters');

    // Marketing-only dropdown filters
    document.getElementById('mkProgramFilter').addEventListener('change', () => { currentPage = 1; renderMarketingPage(); });
    document.getElementById('mkTypeFilter').addEventListener('change', () => { currentPage = 1; renderMarketingPage(); });

    // Pagination controls
    document.getElementById('prevPage').addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderPage(); } });
    document.getElementById('nextPage').addEventListener('click', () => { currentPage++; renderPage(); });
    document.getElementById('perPage').addEventListener('change', (e) => {
        perPage = parseInt(e.target.value, 10) || 10;
        currentPage = 1;
        if (currentListings.length > 0) renderPage();
    });

    handleSearchTypeChange();

    // Initialize address autocomplete (uses server-side proxy)
    initAutocomplete();

    // Initialize program pre-filter selector
    initProgramSelector();

    // Initialize Google Maps widget
    initMap();

    // Tab switching
    document.getElementById('tabBtnFind').addEventListener('click', () => switchTab('find'));
    document.getElementById('tabBtnProgram').addEventListener('click', () => switchTab('program'));
    document.getElementById('tabBtnMarketing').addEventListener('click', () => switchTab('marketing'));

    // Program search tab + marketing tab (both depend on programLocations)
    await initProgramSearch();
    initMarketingTab();
    document.getElementById('psProgram').addEventListener('change', onPsProgramChange);
    document.getElementById('psState').addEventListener('change', onPsStateChange);
    document.getElementById('psCounty').addEventListener('change', onPsCountyChange);
    document.getElementById('programSearchForm').addEventListener('submit', handleProgramSearch);
    document.getElementById('mkState').addEventListener('change', onMkStateChange);
    document.getElementById('mkCounty').addEventListener('change', onMkCountyChange);
    document.getElementById('marketingSearchForm').addEventListener('submit', handleMarketingSearch);
});
