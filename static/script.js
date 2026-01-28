/**
 * Property Search Dashboard - Frontend JavaScript
 */

// =============================================================================
// State & Configuration
// =============================================================================

let currentListings = [];

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

async function verifyListingLive(address, rentcastPrice) {
    const response = await fetch('/api/verify-live', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            address: address,
            rentcast_price: rentcastPrice
        })
    });
    return await response.json();
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
        
        <div class="modal-section">
            <div class="modal-section-title">Live Verification</div>
            <p class="verify-description">Check current listing data from Zillow to compare with RentCast data.</p>
            <button type="button" class="btn btn-verify" id="verifyBtn" 
                data-address="${(listing.formattedAddress || '').replace(/"/g, '&quot;')}"
                data-price="${listing.price || 0}">
                <span class="btn-text">Run Live Web Check</span>
                <span class="btn-loader" style="display: none;"></span>
            </button>
            <div id="verifyResult" class="verify-result" style="display: none;"></div>
        </div>
    `;
    
    // Add event listener for verify button
    const verifyBtn = content.querySelector('#verifyBtn');
    verifyBtn.addEventListener('click', handleLiveVerify);
    
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

async function handleLiveVerify(e) {
    const btn = e.currentTarget;
    const address = btn.dataset.address;
    const rentcastPrice = parseInt(btn.dataset.price) || null;
    const resultContainer = document.getElementById('verifyResult');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    
    // Show loading state
    btn.disabled = true;
    btnText.textContent = 'Agent is searching live listings...';
    btnLoader.style.display = 'inline-block';
    resultContainer.style.display = 'none';
    
    try {
        const result = await verifyListingLive(address, rentcastPrice);
        
        if (result.success) {
            // Build comparison card
            const priceClass = result.price_status === 'lower' ? 'price-lower' : 
                              result.price_status === 'higher' ? 'price-higher' : 'price-same';
            
            const priceDiffText = result.price_difference !== null 
                ? `(${result.price_difference >= 0 ? '+' : ''}$${result.price_difference.toLocaleString()} / ${result.price_change_percent >= 0 ? '+' : ''}${result.price_change_percent}%)`
                : '';
            
            resultContainer.innerHTML = `
                <div class="verify-card">
                    <div class="verify-comparison">
                        <div class="verify-item">
                            <span class="verify-label">RentCast Price</span>
                            <span class="verify-value">${formatPrice(rentcastPrice)}</span>
                        </div>
                        <div class="verify-item">
                            <span class="verify-label">Live Zillow Price</span>
                            <span class="verify-value ${priceClass}">${formatPrice(result.live_price)} ${priceDiffText}</span>
                        </div>
                        ${result.live_days_on_market ? `
                        <div class="verify-item">
                            <span class="verify-label">Zillow Days on Market</span>
                            <span class="verify-value">${result.live_days_on_market}</span>
                        </div>
                        ` : ''}
                    </div>
                    <a href="${result.zillow_url}" target="_blank" class="verify-link">View on Zillow</a>
                </div>
            `;
        } else {
            // Show error with manual link
            const manualUrl = result.zillow_url || result.manual_search_url || 
                `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`;
            
            resultContainer.innerHTML = `
                <div class="verify-card verify-error">
                    <p class="verify-error-text">${result.error || 'Automated check failed'}</p>
                    ${result.message ? `<p class="verify-error-hint">${result.message}</p>` : ''}
                    <a href="${manualUrl}" target="_blank" class="verify-link">Verify manually on Zillow</a>
                </div>
            `;
        }
        
        resultContainer.style.display = 'block';
        
    } catch (error) {
        resultContainer.innerHTML = `
            <div class="verify-card verify-error">
                <p class="verify-error-text">Failed to connect to verification service</p>
                <a href="https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/" target="_blank" class="verify-link">Search manually on Zillow</a>
            </div>
        `;
        resultContainer.style.display = 'block';
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Run Live Web Check';
        btnLoader.style.display = 'none';
    }
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
    showLoading(true);
    
    try {
        const result = await searchListings(query, radius, limit, searchType);
        
        if (result.success) {
            currentListings = result.listings;
            renderListings(result.listings);
            
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
    
    // Initialize search type state
    handleSearchTypeChange();
});
