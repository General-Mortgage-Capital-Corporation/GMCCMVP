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

const STATUS_ICONS = {
    pass: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unverified: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#94a3b8" stroke-width="2"/><path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

// =============================================================================
// Utility
// =============================================================================

function formatPrice(price) {
    if (!price) return 'Price N/A';
    return '$' + price.toLocaleString();
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
        `<div class="autocomplete-item" data-text="${s.text.replace(/"/g, '&quot;')}">${s.text}</div>`
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
    const params = new URLSearchParams({ query, radius, search_type: searchType });
    const programs = getSelectedProgramsParam();
    if (programs) params.set('programs', programs);

    // Pass map marker lat/lng so server uses the actual searched address as distance center
    const marker = window._searchMapMarker;
    if (marker && marker.position) {
        params.set('lat', marker.position.lat);
        params.set('lng', marker.position.lng);
    }

    const response = await fetch(`/api/search?${params}`);
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

    // Batch match all visible listings in one request
    fetch('/api/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toMatch.map(item => item.listing))
    })
    .then(r => r.json())
    .then(data => {
        if (data.success && data.results) {
            data.results.forEach((result, i) => {
                const { index, listing } = toMatch[i];
                listing.matchData = { programs: result.programs };
                listing.censusData = result.census_data || null;
                listing.matchLoading = false;
                updateCardPrograms(index, result.programs);
            });
            populateFilterDropdown();

            // Clear pre-screen message once real match data arrives
            if (selectedPrograms.length > 0) {
                showMessage(null);
                renderFilteredPage();
            }
        }
    })
    .catch(() => {
        toMatch.forEach(({ listing }) => { listing.matchLoading = false; });
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
            return `<span class="prog-badge ${cls}">${p.program_name}</span>`;
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
                <div class="criterion-label">${label}</div>
                <div class="criterion-detail">${criterion.detail}</div>
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
        <span class="program-name">${program.program_name}</span>
        <span class="program-status ${statusClass}">${program.status}</span>
        <span class="program-tier">${tierText}</span>
        <span class="program-chevron">&#9656;</span>
    `;

    const body = document.createElement('div');
    body.className = 'program-card-body';
    body.style.display = 'none';
    body.innerHTML = `
        ${renderCriteriaGrid(program)}
        <button class="btn-talking-points" data-program="${program.program_name}" data-tier="${program.best_tier || ''}">Get Talking Points</button>
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
            tpBtn.textContent = 'Get Talking Points';
        }
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
}

function populateFilterDropdown() {
    const select = document.getElementById('programFilter');
    const currentValue = select.value;
    const programNames = new Set();
    currentListings.forEach(listing => {
        if (listing.matchData && listing.matchData.programs) {
            listing.matchData.programs.forEach(p => {
                if (p.status !== 'Ineligible') programNames.add(p.program_name);
            });
        }
    });
    select.innerHTML = '<option value="">All Programs</option>';
    Array.from(programNames).sort().forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
    // Preserve current filter selection
    if (currentValue && programNames.has(currentValue)) {
        select.value = currentValue;
    }
}

function showFilterBar() {
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.remove('hidden');
}

function getMatchScore(listing, activePrograms) {
    if (!listing.matchData) return 0;
    let score = 0;
    listing.matchData.programs.forEach(p => {
        // Skip programs not in the active filter (if any filter is set)
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
            // If match data hasn't loaded yet, keep the listing (will re-filter later)
            if (!listing.matchData) return true;
            return listing.matchData.programs.some(p =>
                selectedPrograms.includes(p.program_name) && p.status !== 'Ineligible'
            );
        });
    }

    // Apply post-search program filter (single-select dropdown)
    const programName = document.getElementById('programFilter').value;
    if (programName) {
        listings = listings.filter(listing =>
            listing.matchData && listing.matchData.programs &&
            listing.matchData.programs.some(p => p.program_name === programName && p.status !== 'Ineligible')
        );
    }

    // Sort
    const sortBy = document.getElementById('sortBy').value;
    listings = [...listings]; // shallow copy to avoid mutating currentListings
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
        case 'best-match':
            // Determine active program filter: post-search dropdown takes priority, then pre-search selection
            const postFilter = document.getElementById('programFilter').value;
            const activePrograms = postFilter ? [postFilter] : (selectedPrograms.length > 0 ? selectedPrograms : null);
            listings.sort((a, b) => getMatchScore(b, activePrograms) - getMatchScore(a, activePrograms));
            break;
        case 'distance':
        default:
            listings.sort((a, b) => (a.distance || 999) - (b.distance || 999));
            break;
    }

    return listings;
}

function filterByProgram() {
    currentPage = 1;
    renderFilteredPage();
}

function renderFilteredPage() {
    const filtered = getFilteredListings();
    const programName = document.getElementById('programFilter').value;
    const grid = document.getElementById('resultsGrid');
    grid.innerHTML = '';

    const totalPages = Math.ceil(filtered.length / perPage);
    if (currentPage > totalPages) currentPage = totalPages || 1;

    const start = (currentPage - 1) * perPage;
    const end = Math.min(start + perPage, filtered.length);
    const pageListings = filtered.slice(start, end);

    pageListings.forEach(listing => {
        const index = currentListings.indexOf(listing);
        grid.appendChild(createPropertyCard(listing, index));
    });

    renderPagination(totalPages);

    // Update stats bar with filtered listings when filtering is active
    const isFiltering = programName || selectedPrograms.length > 0;
    if (isFiltering) {
        updateStats(filtered);
    }

    const summary = document.getElementById('filterSummary');
    if (isFiltering) {
        // Count how many listings have been fully matched vs still pending
        const matchedCount = currentListings.filter(l => l.matchData).length;
        const totalCount = currentListings.length;
        if (matchedCount < totalCount) {
            summary.textContent = `Showing ${filtered.length} verified matches (${totalCount - matchedCount} still checking...)`;
        } else {
            summary.textContent = `${filtered.length} of ${totalCount} properties match selected programs`;
        }
    } else {
        summary.textContent = '';
    }

    // Lazy-match only the listings visible on this page
    matchPageListings();
}

function resetMatching() {
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.add('hidden');
    const select = document.getElementById('programFilter');
    if (select) select.innerHTML = '<option value="">All Programs</option>';
    const sortBy = document.getElementById('sortBy');
    if (sortBy) sortBy.value = 'distance';
    const summary = document.getElementById('filterSummary');
    if (summary) summary.textContent = '';
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
            <span class="msa-badge ${incomeBadgeClass}">${incomeLevel} Income</span>
            <span class="msa-badge ${mmctBadgeClass}">${isMMCT ? 'In-MMCT' : 'Not MMCT'}</span>
        </div>
        <div class="msa-grid">
            <div class="msa-item">
                <span class="msa-label">MSA/MD Code</span>
                <span class="msa-value">${censusData.msa_code || 'N/A'}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">MSA Name</span>
                <span class="msa-value">${censusData.msa_name || 'N/A'}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract Income Level</span>
                <span class="msa-value">${incomeLevel}</span>
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
                <span class="msa-label">FFIEC MSA Median Income</span>
                <span class="msa-value">${formatCurrency(censusData.ffiec_mfi)}</span>
            </div>
            <div class="msa-item">
                <span class="msa-label">Tract Median Income</span>
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
    const prices = listings.map(l => l.price).filter(p => p);
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
                return `<span class="prog-badge ${cls}">${p.program_name}</span>`;
            }).join('');
        }
    } else {
        programsHtml = '<span class="prog-badge prog-badge-loading">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>';
    }

    card.innerHTML = `
        <div class="property-card-content">
            <div class="property-price">${price}</div>
            <div class="property-address">${address}</div>
            <div class="property-badges">
                <span class="badge badge-days">${days} days on market</span>
                <span class="badge badge-type">${propertyType}</span>
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
    const modal = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');

    const agent = listing.listingAgent || {};
    const builder = listing.builder || {};
    const office = listing.listingOffice || {};
    const hoa = listing.hoa || {};

    let contactHtml = '';
    if (agent.name || agent.phone || agent.email) {
        contactHtml = `<div class="modal-contact">
            <div class="modal-contact-name">${agent.name || 'Agent name not available'}</div>
            <div class="modal-contact-info">
                ${agent.phone ? `Phone: ${formatPhone(agent.phone)}<br>` : ''}
                ${agent.email ? `Email: ${agent.email}<br>` : ''}
                ${agent.website ? `Website: <a href="${agent.website}" target="_blank">${agent.website}</a>` : ''}
            </div>
        </div>`;
    } else if (builder.name) {
        contactHtml = `<div class="modal-contact">
            <div class="modal-contact-name">${builder.name} (Builder)</div>
            <div class="modal-contact-info">
                ${builder.phone ? `Phone: ${formatPhone(builder.phone)}<br>` : ''}
                ${builder.development ? `Development: ${builder.development}<br>` : ''}
                ${builder.website ? `Website: <a href="${builder.website}" target="_blank">${builder.website}</a>` : ''}
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
            <div class="modal-address">${listing.formattedAddress || 'Address not available'}</div>
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
                    <span class="modal-item-value">${listing.propertyType || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Bedrooms</span>
                    <span class="modal-item-value">${listing.bedrooms || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Bathrooms</span>
                    <span class="modal-item-value">${listing.bathrooms || 'N/A'}</span>
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
                    <span class="modal-item-value">${listing.status || 'N/A'}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Listing Information</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-item-label">Listed Date</span>
                    <span class="modal-item-value">${listing.listedDate ? listing.listedDate.slice(0, 10) : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Days on Market</span>
                    <span class="modal-item-value">${listing.daysOnMarket != null ? listing.daysOnMarket + ' days' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">MLS Number</span>
                    <span class="modal-item-value">${listing.mlsNumber || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Last Updated</span>
                    <span class="modal-item-value">${listing.lastSeenDate ? listing.lastSeenDate.slice(0, 10) : 'N/A'}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Location</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-item-label">City</span>
                    <span class="modal-item-value">${listing.city || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">State</span>
                    <span class="modal-item-value">${listing.state || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Zip Code</span>
                    <span class="modal-item-value">${listing.zipCode || 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">County</span>
                    <span class="modal-item-value">${listing.county || 'N/A'}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Contact Information</div>
            ${contactHtml}
            ${office.name ? `<div class="modal-contact" style="margin-top:0.75rem;">
                <div class="modal-contact-name">${office.name} (Office)</div>
                <div class="modal-contact-info">
                    ${office.phone ? `Phone: ${formatPhone(office.phone)}<br>` : ''}
                    ${office.email ? `Email: ${office.email}` : ''}
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
    document.getElementById('modalOverlay').style.display = 'none';
    document.body.style.overflow = '';
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
            if (result.message) showMessage(result.message);
        } else {
            showError(result.error || 'An error occurred while searching.');
            document.getElementById('resultsSection').style.display = 'none';
        }
    } catch (error) {
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
        const data = await resp.json();
        availablePrograms = data.programs || [];
    } catch {
        availablePrograms = [];
    }

    const dropdown = document.getElementById('programSelectDropdown');
    if (!dropdown || !availablePrograms.length) return;

    dropdown.innerHTML = availablePrograms.map((name, i) =>
        `<div class="program-select-item">
            <input type="checkbox" id="progCheck${i}" value="${name.replace(/"/g, '&quot;')}">
            <label for="progCheck${i}">${name}</label>
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
        const resp = await fetch('/api/config');
        const config = await resp.json();
        const apiKey = config.places_api_key;
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
    document.getElementById('programFilter').addEventListener('change', () => filterByProgram());
    document.getElementById('sortBy').addEventListener('change', () => { currentPage = 1; renderFilteredPage(); });

    // Pagination controls
    document.getElementById('prevPage').addEventListener('click', () => { currentPage--; renderPage(); });
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
});
