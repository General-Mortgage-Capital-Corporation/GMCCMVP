"""On-demand LLM explanation generation using Gemini Flash + ChromaDB context.

This module is the ONLY path that calls the Gemini LLM. The matching engine
itself (matcher.py) is fully deterministic with zero LLM calls.
"""

import json

from google import genai

from rag.config import GEMINI_API_KEY, GEMINI_MODEL
from rag.vectorstore import query_program_info


def explain_match(program_name: str, listing: dict, tier_name: str) -> str:
    """Generate a natural-language explanation for why a listing matches a program.

    Args:
        program_name: Name of the matched GMCC program.
        listing: RentCast listing dict with property details.
        tier_name: Name of the matching tier within the program.

    Returns:
        Human-readable explanation string from Gemini Flash.
    """
    # Query ChromaDB for relevant guideline context
    chroma_results = query_program_info(
        query=f"{program_name} {tier_name} eligibility requirements",
        program_name=program_name,
        n_results=3,
    )

    # Extract document text from ChromaDB results
    context_chunks = []
    if chroma_results and chroma_results.get("documents"):
        for doc_list in chroma_results["documents"]:
            if isinstance(doc_list, list):
                context_chunks.extend(doc_list)
            else:
                context_chunks.append(doc_list)

    context_text = "\n\n---\n\n".join(context_chunks) if context_chunks else "No guideline context available."

    # Format listing details
    listing_json = json.dumps(listing, indent=2, default=str)

    # Build prompt
    prompt = f"""You are a mortgage industry expert helping loan officers understand GMCC program eligibility.

**Program:** {program_name}
**Matching Tier:** {tier_name}

**Property Listing Details:**
{listing_json}

**Program Guideline Context:**
{context_text}

**Instructions:**
1. Write a 2-3 sentence program summary explaining why this property qualifies for the {program_name} program under the {tier_name} tier.
2. Provide 3-4 bullet-point talking points the loan officer can use when discussing this program with listing agents.

**Tone:** Professional, concise, focus on what makes this property a good fit for the program. Avoid jargon where possible."""

    # Call Gemini Flash
    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
    )

    return response.text
