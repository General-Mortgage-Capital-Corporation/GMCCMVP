/**
 * Property Search Dashboard - Frontend JavaScript
 */

// =============================================================================
// State & Configuration
// =============================================================================

let currentListings = [];
let matchPending = 0;

const STATUS_ICONS = {
    pass: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unverified: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#94a3b8" stroke-width="2"/><path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

// =============================================================================
// Utility Functions
// =============================================================================

function formatPrice(price) {
    if (!price) return 'Price N/A';
    return '$' + price.toLocaleString();
}

function formatSqft(sqft) {
    if (!sqft) return 'N/A';
    return sqft.toLocaleString() + ' sq ft';
}

function formatPhone(phone) {
    if (!phone) return 'N/A';
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return phone;
}

function formatDistance(distance) {
    if (!distance || distance === 999) return '';
    return distance < 1 
        ? `${(distance * 5280).toFixed(0)} ft away`
        : `${distance.toFixed(1)} mi away`;
}

function renderSimpleMarkdown(text) {
    // Escape HTML entities to prevent XSS
    let escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Bold: **text** -> <strong>text</strong>
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Process lines for bullet lists
    const lines = escaped.split('\n');
    let html = '';
    let inList = false;

    lines.forEach(line => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += '<li>' + trimmed.slice(2) + '</li>';
        } else {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            if (html.length > 0) {
                html += '<br>';
            }
            html += line;
        }
    });

    if (inList) {
        html += '</ul>';
    }

    return html;
}

// =============================================================================
// API Functions
// =============================================================================

async function searchListings(query, radius, limit, searchType) {
    const params = new URLSearchParams({
        query: query,
        radius: radius,
        limit: limit,
        search_type: searchType
    });

    const response = await fetch(`/api/search?${params}`);
    return await response.json();
}

// =============================================================================
// Program Matching Functions
// =============================================================================

function startMatching(listings) {
    matchPending = listings.length;

    listings.forEach((listing, index) => {
        listing.matchLoading = true;

        fetch('/api/match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(listing)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                listing.matchData = data;
                updateCardBadge(index, data.eligible_count);
            }
        })
        .catch(() => {
            // Silent failure -- no badge shown
        })
        .finally(() => {
            listing.matchLoading = false;
            matchPending--;
            if (matchPending <= 0) {
                onAllMatchesComplete();
            }
        });
    });
}

function updateCardBadge(index, eligibleCount) {
    const card = document.querySelector('[data-index="' + index + '"]');
    if (!card) return;

    const badges = card.querySelector('.property-badges');
    if (!badges) return;

    // Remove skeleton loading badge
    const skeleton = badges.querySelector('.badge-programs-loading');
    if (skeleton) skeleton.remove();

    // Add program count badge if eligible
    if (eligibleCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-programs';
        badge.textContent = eligibleCount + ' Program' + (eligibleCount !== 1 ? 's' : '');
        badges.appendChild(badge);
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
        ? (program.best_tier.length > 40 ? program.best_tier.slice(0, 40) + '...' : program.best_tier)
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

    // Toggle expand/collapse
    header.addEventListener('click', () => {
        const isExpanded = card.classList.toggle('expanded');
        body.style.display = isExpanded ? 'block' : 'none';
    });

    // Get Talking Points button handler
    const tpBtn = body.querySelector('.btn-talking-points');
    const tpContent = body.querySelector('.talking-points-content');

    tpBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Check cache first
        if (listing._explanationCache && listing._explanationCache[program.program_name]) {
            tpContent.innerHTML = renderSimpleMarkdown(listing._explanationCache[program.program_name]);
            return;
        }

        // Disable button and show loading
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

function onAllMatchesComplete() {
    populateFilterDropdown();
    showFilterBar();
}

function populateFilterDropdown() {
    const select = document.getElementById('programFilter');
    const programNames = new Set();

    currentListings.forEach(listing => {
        if (listing.matchData && listing.matchData.programs) {
            listing.matchData.programs.forEach(p => {
                if (p.status !== 'Ineligible') {
                    programNames.add(p.program_name);
                }
            });
        }
    });

    // Clear existing options
    select.innerHTML = '<option value="">All Programs</option>';

    // Add sorted program names
    Array.from(programNames).sort().forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

function showFilterBar() {
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.remove('hidden');
}

function filterByProgram(programName) {
    const cards = document.querySelectorAll('.property-card');
    let visibleCount = 0;

    cards.forEach(card => {
        const index = parseInt(card.getAttribute('data-index'), 10);
        const listing = currentListings[index];

        if (!programName) {
            // All Programs -- show everything
            card.classList.remove('hidden');
            visibleCount++;
        } else if (listing && listing.matchData && listing.matchData.programs) {
            const hasProgram = listing.matchData.programs.some(
                p => p.program_name === programName && p.status !== 'Ineligible'
            );
            if (hasProgram) {
                card.classList.remove('hidden');
                visibleCount++;
            } else {
                card.classList.add('hidden');
            }
        } else {
            card.classList.add('hidden');
        }
    });

    const summary = document.getElementById('filterSummary');
    if (programName) {
        summary.textContent = `Showing ${visibleCount} of ${currentListings.length} properties`;
    } else {
        summary.textContent = '';
    }
}

function resetMatching() {
    matchPending = 0;

    // Hide filter bar on new search
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.classList.add('hidden');

    // Reset filter dropdown to "All Programs"
    const select = document.getElementById('programFilter');
    if (select) select.innerHTML = '<option value="">All Programs</option>';

    // Clear filter summary
    const summary = document.getElementById('filterSummary');
    if (summary) summary.textContent = '';

    // Re-show any hidden cards
    document.querySelectorAll('.property-card.hidden').forEach(card => {
        card.classList.remove('hidden');
    });
}

// =============================================================================
// UI Functions
// =============================================================================

function showLoading(show) {
    const btn = document.getElementById('searchBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    
    btn.disabled = show;
    btnText.textContent = show ? 'Searching...' : 'Search';
    btnLoader.style.display = show ? 'block' : 'none';
}

function showError(message) {
    const errorBanner = document.getElementById('errorBanner');
    const errorText = document.getElementById('errorText');
    
    errorText.textContent = message;
    errorBanner.style.display = 'block';
    
    // Hide after 5 seconds
    setTimeout(() => {
        errorBanner.style.display = 'none';
    }, 5000);
}

function hideError() {
    document.getElementById('errorBanner').style.display = 'none';
}

function showMessage(message) {
    const banner = document.getElementById('messageBanner');
    const text = document.getElementById('messageText');
    
    if (message) {
        text.textContent = message;
        banner.style.display = 'block';
    } else {
        banner.style.display = 'none';
    }
}

function updateStats(listings) {
    const count = listings.length;
    const prices = listings.map(l => l.price).filter(p => p);
    const days = listings.map(l => l.daysOnMarket).filter(d => d !== undefined && d !== null);
    
    document.getElementById('statCount').textContent = count;
    
    if (prices.length > 0) {
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        document.getElementById('statAvgPrice').textContent = formatPrice(avgPrice);
        
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        document.getElementById('statPriceRange').textContent = 
            `${formatPrice(minPrice)} - ${formatPrice(maxPrice)}`;
    } else {
        document.getElementById('statAvgPrice').textContent = '-';
        document.getElementById('statPriceRange').textContent = '-';
    }
    
    if (days.length > 0) {
        const avgDays = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
        document.getElementById('statAvgDays').textContent = `${avgDays} days`;
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
    const days = listing.daysOnMarket !== undefined ? listing.daysOnMarket : 'N/A';
    const propertyType = listing.propertyType || 'Unknown';
    const beds = listing.bedrooms || 'N/A';
    const baths = listing.bathrooms || 'N/A';
    const sqft = listing.squareFootage ? listing.squareFootage.toLocaleString() : 'N/A';
    const distance = formatDistance(listing.distance);
    
    card.innerHTML = `
        <div class="property-card-content">
            <div class="property-price">${price}</div>
            <div class="property-address">${address}</div>
            <div class="property-badges">
                <span class="badge badge-days">${days} days on market</span>
                <span class="badge badge-type">${propertyType}</span>
                <span class="badge badge-programs-loading">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
            </div>
            <div class="property-stats">
                <div class="property-stat">
                    <span class="property-stat-value">${beds}</span>
                    <span class="property-stat-label">Beds</span>
                </div>
                <div class="property-stat">
                    <span class="property-stat-value">${baths}</span>
                    <span class="property-stat-label">Baths</span>
                </div>
                <div class="property-stat">
                    <span class="property-stat-value">${sqft}</span>
                    <span class="property-stat-label">Sq Ft</span>
                </div>
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
    
    grid.innerHTML = '';
    
    if (listings.length === 0) {
        noResults.style.display = 'block';
        grid.style.display = 'none';
        document.getElementById('statsBar').style.display = 'none';
    } else {
        noResults.style.display = 'none';
        grid.style.display = 'grid';
        document.getElementById('statsBar').style.display = 'grid';
        
        listings.forEach((listing, index) => {
            grid.appendChild(createPropertyCard(listing, index));
        });
        
        updateStats(listings);
    }
    
    resultsSection.style.display = 'block';
}

// =============================================================================
// Modal Functions
// =============================================================================

function openPropertyModal(listing) {
    const modal = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');
    
    const agent = listing.listingAgent || {};
    const builder = listing.builder || {};
    const office = listing.listingOffice || {};
    const hoa = listing.hoa || {};
    
    // Determine contact info
    let contactHtml = '';
    if (agent.name || agent.phone || agent.email) {
        contactHtml = `
            <div class="modal-contact">
                <div class="modal-contact-name">${agent.name || 'Agent name not available'}</div>
                <div class="modal-contact-info">
                    ${agent.phone ? `Phone: ${formatPhone(agent.phone)}<br>` : ''}
                    ${agent.email ? `Email: ${agent.email}<br>` : ''}
                    ${agent.website ? `Website: <a href="${agent.website}" target="_blank">${agent.website}</a>` : ''}
                </div>
            </div>
        `;
    } else if (builder.name) {
        contactHtml = `
            <div class="modal-contact">
                <div class="modal-contact-name">${builder.name} (Builder)</div>
                <div class="modal-contact-info">
                    ${builder.phone ? `Phone: ${formatPhone(builder.phone)}<br>` : ''}
                    ${builder.development ? `Development: ${builder.development}<br>` : ''}
                    ${builder.website ? `Website: <a href="${builder.website}" target="_blank">${builder.website}</a>` : ''}
                </div>
            </div>
        `;
    } else {
        contactHtml = `<div class="modal-contact"><div class="modal-contact-info">No contact information available</div></div>`;
    }
    
    content.innerHTML = `
        <div class="modal-header">
            <div class="modal-price">${formatPrice(listing.price)}</div>
            <div class="modal-address">${listing.formattedAddress || 'Address not available'}</div>
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
                    <span class="modal-item-value">${formatSqft(listing.squareFootage)}</span>
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

        <!-- Matching Programs Section -->
        <div class="modal-section" id="modalProgramsSection">
            <div class="modal-section-title">Matching Programs</div>
            <div id="programCardsContainer">
                ${listing.matchLoading ? '<div class="programs-loading">Loading program matches...</div>' : ''}
                ${!listing.matchData && !listing.matchLoading ? '' : ''}
                ${listing.matchData && listing.matchData.programs.filter(p => p.status !== 'Ineligible').length === 0 && !listing.matchLoading ? '<div class="programs-empty">No matching GMCC programs found for this property</div>' : ''}
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
                    <span class="modal-item-value">${listing.daysOnMarket !== undefined ? listing.daysOnMarket + ' days' : 'N/A'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-item-label">Listing Type</span>
                    <span class="modal-item-value">${listing.listingType || 'N/A'}</span>
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
            ${office.name ? `
                <div class="modal-contact" style="margin-top: 0.75rem;">
                    <div class="modal-contact-name">${office.name} (Office)</div>
                    <div class="modal-contact-info">
                        ${office.phone ? `Phone: ${formatPhone(office.phone)}<br>` : ''}
                        ${office.email ? `Email: ${office.email}` : ''}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    
    // Append program cards with event listeners
    if (listing.matchData) {
        const container = document.getElementById('programCardsContainer');
        const matchedPrograms = listing.matchData.programs.filter(p => p.status !== 'Ineligible');
        matchedPrograms.forEach(program => {
            container.appendChild(createProgramCard(program, listing));
        });
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
    
    const query = document.getElementById('searchQuery').value.trim();
    const radius = document.getElementById('radius').value;
    const limit = document.getElementById('limit').value;
    const searchType = document.getElementById('searchType').value;
    
    if (!query) {
        showError('Please enter a search location.');
        return;
    }
    
    hideError();
    showMessage(null);
    resetMatching();
    showLoading(true);
    
    try {
        const result = await searchListings(query, radius, limit, searchType);
        
        if (result.success) {
            currentListings = result.listings;
            renderListings(result.listings);

            // Fire async program matching for each listing
            startMatching(currentListings);

            if (result.message) {
                showMessage(result.message);
            }
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
    
    if (searchType === 'specific') {
        radiusGroup.style.opacity = '0.5';
        radiusGroup.style.pointerEvents = 'none';
    } else {
        radiusGroup.style.opacity = '1';
        radiusGroup.style.pointerEvents = 'auto';
    }
}

function handleRadiusChange() {
    const radius = document.getElementById('radius').value;
    document.getElementById('radiusValue').textContent = radius;
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Form submission
    document.getElementById('searchForm').addEventListener('submit', handleSearch);
    
    // Search type change
    document.getElementById('searchType').addEventListener('change', handleSearchTypeChange);
    
    // Radius slider
    document.getElementById('radius').addEventListener('input', handleRadiusChange);
    
    // Modal close
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('modalOverlay')) {
            closeModal();
        }
    });
    
    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    });
    
    // Program filter
    document.getElementById('programFilter').addEventListener('change', (e) => {
        filterByProgram(e.target.value);
    });

    // Initialize search type state
    handleSearchTypeChange();
});
