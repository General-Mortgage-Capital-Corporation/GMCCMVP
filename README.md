# GMCC Property Search Dashboard

Property search tool that matches real estate listings against GMCC loan programs using RentCast data, FFIEC census data, and deterministic eligibility rules.

## Features

- **Find Properties** — Area or exact address search via RentCast API with interactive Google Maps
- **Search by Program** — Browse eligible counties by program with cascading state/county/city filters
- **Program Matching** — Deterministic rule-based matching with three-value logic (Eligible / Potentially Eligible / Ineligible)
- **Census Data** — Automatic FFIEC geocoding + Census ACS demographics for LMI tract and MMCT verification
- **Talking Points** — AI-generated talking points for matched programs (Gemini Flash)
- **Sort & Filter** — Sort by price, distance, days on market, best match; filter by program

## Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Create a `.env` file:
   ```
   RENTCAST_API_KEY=your_key
   GEMINI_API_KEY=your_key
   GOOGLE_PLACES_API_KEY=your_key
   ```

3. Run:
   ```bash
   python server.py
   ```

4. Open http://localhost:5000

## API Keys

- **RentCast** — property listings ([rentcast.io](https://app.rentcast.io/app/api))
- **Google Places** — address autocomplete + map widget
- **Gemini** — talking points generation

## Architecture

- `server.py` — Flask backend, proxies RentCast API, orchestrates matching
- `matching/matcher.py` — Rule-based matching engine (no LLM)
- `matching/census.py` — Census Bureau geocoder + FFIEC tract lookup + ACS demographics
- `matching/explain.py` — Gemini Flash talking points
- `data/programs/` — Program rule JSONs (one per program)
- `data/county_fips.json` — County FIPS → name, state, centroid, cities lookup
- `static/` — Vanilla JS + CSS frontend
