# GMCC Frontend (Next.js)

The Next.js frontend for the GMCC Property Search Dashboard. See the [root README](../README.md) for full architecture and deployment documentation.

## Local Development

```bash
npm install
cp .env.local.example .env.local   # fill in your keys
npm run dev                         # http://localhost:3000
```

The Python matching backend must also be running locally (`python server.py` from repo root) unless you point `PYTHON_SERVICE_URL` at the deployed backend.

## Structure

```
src/
  app/
    page.tsx                  ← Main dashboard (LO tabs: AI Agent, CRA Check, Marketing, GPS Radius, By Program, Refi Finder;
                                 partner tabs: CRA Check, GPS Radius, Flyers)
    api/                      ← Next.js API routes (server-side proxies)
      search/                 ← RentCast property search
      match/                  ← Proxy to Python matcher
      marketing-search/       ← Full-county marketing search stream
      program-search/         ← Program-specific county search stream
      generate-flier/         ← Proxy to Firebase Cloud Function (PDF generation)
      suggest-email/          ← Gemini email suggestion
      autocomplete/           ← Google Places address autocomplete
      cra-check/              ← CRA address fast-check
      chat/                   ← AI agent (ToolLoopAgent)
      refi/, refi-subscription/ ← Refi Finder (credit-gated)
      partner/                ← Partner profile + flyer template catalog
  components/
    property/PropertyGrid.tsx ← List/card view for GPS radius results
    marketing/                ← Massive Marketing tab components
    program/                  ← Market by Program tab components
    cra/                      ← CRA Address Fast Check tab
    flier/FlierButton.tsx     ← Preview/Download/Email/Guideline buttons
    flyers/PartnerFlyersTab.tsx ← Partner-only co-branded flyer builder
    partner/                  ← Partner lead-intake (survey link + QR) banner
    chat/, refi/              ← AI Agent and Refi Finder tabs
    PropertyModal.tsx         ← Property detail modal with program matching
    PropertyCard.tsx          ← Card view item
  contexts/AuthContext.tsx    ← Firebase + Azure MSAL auth (LOs) / email-password (partners)
  lib/
    api.ts                    ← API client functions
    firebase-auth.ts          ← Firebase Auth helpers
    utils.ts                  ← Formatting utilities, chip filter logic
  types/index.ts              ← Shared TypeScript types
```

## Environment Variables

See `.env.local.example` for all required variables with descriptions.

## Key Concepts

**Primary vs Secondary programs**: Primary programs appear as badges in search results and in filter dropdowns. Secondary (community lending) programs appear only inside the property detail modal under "Community Lending Programs". The `is_secondary` flag comes from the Python matcher; which programs the pickers offer is decided separately by `/api/programs` (see "Loan programs" in the root README).

**Flier generation**: Handled by Firebase Cloud Functions (`fillPdfFlier`). Users must be signed in via Firebase Auth; partner calls are rendered under the owning LO's account server-side. Program-to-productId mapping lives in `flier/FlierButton.tsx` — add `guidelineUrl` to unlock the Guideline button for a program.

**Matching**: The Python service returns `ProgramResult[]` with `status: "Eligible" | "Potentially Eligible" | "Ineligible"` and `is_secondary: boolean`. The frontend never re-derives eligibility — it only renders what the backend returns.
