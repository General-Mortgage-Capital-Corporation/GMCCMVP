"""On-demand LLM explanation generation using Gemini Flash.

No ChromaDB -- program rules JSON is passed directly as context.
"""

import json

from google import genai

from rag.config import GEMINI_API_KEY, GEMINI_MODEL


def explain_match(
    program_name: str,
    listing: dict,
    tier_name: str,
    program_rules: dict | None = None,
) -> str:
    """Generate a natural-language explanation for why a listing matches a program.

    Args:
        program_name: Name of the matched GMCC program.
        listing: RentCast listing dict with property details.
        tier_name: Name of the matching tier within the program.
        program_rules: Optional program rules dict loaded from JSON (used as context).

    Returns:
        Human-readable explanation string from Gemini Flash.
    """
    context_text = "No program rules available."
    if program_rules:
        notes = program_rules.get("general_notes", [])
        tiers = program_rules.get("tiers", [])
        tier_info = next((t for t in tiers if t.get("tier_name") == tier_name), None)
        context_parts = []
        if notes:
            context_parts.append("Program Notes:\n" + "\n".join(f"- {n}" for n in notes))
        if tier_info:
            additional = tier_info.get("additional_rules", {})
            desc = additional.get("description", "")
            incentive = additional.get("cra_incentive", "")
            if desc:
                context_parts.append(f"Tier Description: {desc}")
            if incentive:
                context_parts.append(f"CRA Incentive: {incentive}")
        context_text = "\n\n".join(context_parts) if context_parts else context_text

    listing_summary = {
        k: v for k, v in listing.items()
        if k in ("formattedAddress", "price", "propertyType", "state", "county", "zipCode",
                  "bedrooms", "bathrooms", "squareFootage")
    }
    listing_json = json.dumps(listing_summary, indent=2, default=str)

    prompt = f"""You are a mortgage industry expert helping loan officers understand GMCC program eligibility.

**Program:** {program_name}
**Matching Tier:** {tier_name}

**Property Details:**
{listing_json}

**Program Context:**
{context_text}

**Instructions:**
1. Write 2-3 sentences explaining why this property qualifies for {program_name}.
2. Provide 3-4 bullet-point talking points the loan officer can use with listing agents.

**Tone:** Professional, concise, focus on the CRA pricing advantage and what makes this property a good fit."""

    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
    )

    return response.text
