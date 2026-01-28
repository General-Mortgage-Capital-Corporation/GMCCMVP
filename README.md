# Property Search Dashboard

Property search dashboard using Flask and the RentCast API.

## Features

- Search by address or zip code
- Area search (radius) or exact address lookup
- Property cards with extensive details and contact information
- Click cards for full details

## Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Create a `.env` file with your API key:
   ```
   RENTCAST_API_KEY=your_api_key_here
   ```
   Get a key from [RentCast](https://app.rentcast.io/app/api).

3. Run:
   ```bash
   python server.py
   ```

4. Open `http://localhost:5000`

## API Notes

- Each search uses 1 API call
- Only active listings are returned
- Results limited to max 50 per search

For full API documentation, see [RentCast API Docs](https://developers.rentcast.io/reference/sale-listings).
