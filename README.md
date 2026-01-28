# Property Search Dashboard

A clean, modern property search dashboard with a Flask backend and vanilla JS frontend, powered by the RentCast API.

## Features

- **Flexible Search**: Search by address (area search with radius) or specific property
- **Zip Code Support**: Enter a 5-digit zip code for location-based searches
- **Smart Exact Match**: For specific address searches, shows exact match only or nearby properties with a clear message
- **Distance Sorting**: Results ordered by distance from search location
- **Summary Statistics**: View property count, average price, price range, and days on market
- **Property Cards**: Clean display of price, address, days on market, beds, baths, sqft
- **Detailed Modal**: Click any card to see full details including agent contact info
- **Modern UI**: Clean, minimal design inspired by shadcn/modern SaaS aesthetics

## Project Structure

```
├── .env                    # API key configuration (create this)
├── .gitignore             # Git ignore file
├── server.py              # Flask backend API
├── requirements.txt       # Python dependencies
├── README.md              # This file
└── static/
    ├── index.html         # Main HTML page
    ├── styles.css         # CSS styles
    └── script.js          # Frontend JavaScript
```

## Setup

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure API Key

Create a `.env` file in the project root (or edit the existing one):

```
RENTCAST_API_KEY=your_actual_api_key_here
```

You can get an API key from [RentCast](https://app.rentcast.io/app/api).

### 3. Run the Application

```bash
python server.py
```

The dashboard will be available at `http://localhost:5000`

## Usage

1. **Enter Location**: Type an address (e.g., "123 Main St, Austin, TX") or a 5-digit zip code

2. **Select Search Type**:
   - **Area Search**: Finds listings within a radius of the location
   - **Exact Address**: Finds that specific property, or shows nearby if no exact match

3. **Adjust Settings**:
   - **Radius**: For area searches, set the search radius (1-50 miles)
   - **Results**: Choose how many properties to display (5-50)

4. **Click Search**: Results will display below with summary statistics

5. **View Details**: Click any property card to open a modal with full details

## Search Behavior

### Area Search
- Searches within the specified radius of the location
- Results sorted by distance from center
- Shows the number of properties you selected

### Exact Address Search
- First looks for an exact match at the address
- If found: shows only that one property
- If not found: shows properties within 1 mile with a message explaining no exact match was found

## API Usage Notes

**Important**: Each search uses 1 API call.

- Results are limited to your selected amount (max 50)
- Only **Active** listings are returned
- Keep searches reasonable to stay under your API limit

## Customization

### Styling
Edit `static/styles.css` to customize:
- Colors (CSS variables at the top)
- Card layouts
- Typography
- Spacing

### Property Card Fields
Edit `static/script.js` in the `createPropertyCard()` function to change what displays on cards.

### Modal Fields
Edit `static/script.js` in the `openPropertyModal()` function to add/remove detail fields.

### Backend Logic
Edit `server.py` to modify:
- API parameters
- Distance calculations
- Response formatting

## Tech Stack

- **Backend**: Python 3.8+ with Flask
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **HTTP Client**: Requests
- **Data Source**: RentCast API

## API Reference

- **Endpoint**: `GET https://api.rentcast.io/v1/listings/sale`
- **Auth**: Header `X-Api-Key: YOUR_API_KEY`
- **Key Parameters**:
  - `address` - Full address or center point for radius search
  - `zipCode` - 5-digit zip code
  - `radius` - Search radius in miles (max 100)
  - `status` - Listing status (Active/Inactive)
  - `limit` - Max results (1-500)

For full API documentation, visit [RentCast API Docs](https://developers.rentcast.io/reference/sale-listings).
