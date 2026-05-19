# Refi Finder — Day 1 Findings

Date: 2026-05-19. Spike spend: **10 records** of 10,000 monthly quota (Solo plan + 30-day API trial).

## TL;DR

**Green-light Day 2.** PropertyRadar returns every column the v1 table needs when fetched with `Fields=All`. Cost is per-row, not per-field, so we lose nothing by always pulling the full payload.

## What we proved

1. **API access works** with the trial token from `frontend/.env.local` (now mirrored to root `.env`).
2. **Cost model confirmed:** `Purchase=0` previews are free. Paid fetches charge 1 record per row regardless of fieldset size.
3. **Filter syntax works.** The `Criteria` array model accepts our refi preset (purpose, rate type, date range, equity, owner-occupancy, zip).
4. **The data is usable.** Sample row in Cupertino: $3.67M AVM, 88% equity, 6.81% fixed rate from Rocket Mortgage Feb 2023 — exactly the refi target an LO would want to call.

## Field coverage (Fields=All)

Every v1 table column has a populated field:

| UI column | API field | Notes |
|---|---|---|
| Address | `Address`, `City`, `State`, `ZipFive` | ✅ |
| Owner name | `Owner`, `OwnerFirstName`, `OwnerLastName` | ✅ (occasionally only `Owner` populated when entity-owned) |
| Owner-occupied | `isSameMailingOrExempt` | ✅ |
| Property type | `PType` (`SFR`/`CND`/...) + `AdvancedPropertyType` (label) | ✅ |
| Beds / Baths / SqFt / Year built | `Beds`, `Baths`, `SqFt`, `YearBuilt` | ✅ |
| AVM (current value) | `AVM` + `AVMAsOf` + `AVMReliability` | ✅ |
| Available equity | `AvailableEquity`, `EquityPercent` | ✅ |
| Current loan balance | `TotalLoanBalance` | ✅ |
| Current LTV (CLTV) | `CLTV` | ✅ |
| # liens | `NumberLoans` | ✅ |
| Loan date | `FirstDate` | ✅ |
| Loan amount | `FirstAmount` | ✅ |
| Original LTV | `FirstAmountLTV` | ⚠️ Partial (4/9 — null in non-disclosure states or when origination sale price unknown) |
| Purpose | `FirstPurpose` (`Cash Out`/`PMoney`/`R&TRefi`/etc.) | ✅ |
| Loan type | `FirstLoanType` (`Conforming`/`FHA`/`VA`/`Non-Conforming`/...) | ✅ |
| Rate type | `FirstRateType` (`Fixed`/`Adjustable`) | ✅ |
| Est. rate | `FirstRate` | ✅ (modeled for fixed — label as "Est.") |
| Term | `FirstTermInYears` | ✅ |
| Lender | `FirstLenderOriginal` | ✅ (LO name still not available — fall back to lender entity) |
| Last sale | `LastTransferRecDate`, `LastTransferValue` | ✅ |
| Census tract (for FFIEC) | `CensusTract`, `CensusBlock` | ✅ |
| County | `County` (name) | ✅ (no FIPS — derive from county+state) |
| Lat / Long | `Latitude`, `Longitude` | ✅ |
| APN | `APN` | ✅ |
| Tax info | `AnnualTaxes`, `EstimatedTaxRate` | bonus |
| Drill-down | `Transactions`, `CompsSales` href links | bonus |

## Critical doc corrections vs prior research

1. **`FirstPurpose` enum is `CashOut|Construction|ELOC|PMoney|R&TRefi|Reverse|Wrap|Unknown`** — NOT `P/R/C/U` as the criteria-reference summary claimed. API error messages are authoritative.
2. **`FirstLoanType` returns string labels** (`Conforming`, not `C`) in the response, even though the input criterion uses codes. Need a labels<->codes map.
3. **`FirstRateType` returns string labels** (`Fixed`, `Adjustable`) in the response. Same input/output mismatch.
4. **`FIPS` not in response.** Have `County` name + `State` — derive FIPS via `/v1/suggestions/County` (free) or cache locally.
5. **Network timeout:** raised client default from 30s → 60s. Miami Beach preview (252 results) was timing out at 30.

## Recommended v1 fieldset

Use `Fields=All` everywhere. Cost is identical to `LimitedREI` and we get tract + lat/long + CLTV + TotalLoanBalance for free. Don't fragment.

## What's still unknown (deferrals)

- **Webhooks / monitored lists** for "new refi matches daily" feed — Phase 2.
- **`FirstAssigned` / `FirstLenderCurrent` / `FirstAssignmentDate`** field availability — need a spike against a property whose loan has been sold (TBD). Falls back to "originated by [Lender]" if unavailable.
- **`/transactions` endpoint** drill-down cost and shape — will spike when Day 4 modal lands.

## Day 2 plan

1. Backend route `POST /api/refi/preview` (free, returns count + quota remaining).
2. Backend route `POST /api/refi/search` (paid, returns rows + enriched FFIEC tract data via existing `matching/census.py`).
3. Backend route `GET /api/refi/quota` (reads `data/pr_quota_log.jsonl`).
4. Filter-criteria normalizer that accepts the UI's friendly filter JSON and emits the PropertyRadar `Criteria` array shape (handle the label↔code mismatches above).
5. In-memory or on-disk cache keyed by criteria hash + date to avoid double-spending on a repeat query.
