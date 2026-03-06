"""Markdown-to-structured-JSON via Gemini structured output.

Stage 2 of the two-stage extraction pipeline: LLM-powered conversion of
Markdown content into validated ProgramRules JSON using Gemini Flash.
"""

from google import genai
from google.genai import types

from rag.config import GEMINI_API_KEY, GEMINI_MODEL
from rag.schemas import ProgramRules


def structure_with_llm(markdown_text: str, program_name: str) -> ProgramRules:
    """Use Gemini to extract structured rules from guideline Markdown.

    Sends the full Markdown content to Gemini Flash with a structured output
    schema based on the ProgramRules Pydantic model. The LLM extracts all
    eligibility tiers/matrices and program metadata.

    Args:
        markdown_text: Full Markdown content of the guideline PDF
            (all pages concatenated).
        program_name: Program name (from folder name, NOT from PDF content).

    Returns:
        Validated ProgramRules instance with extracted eligibility tiers.
    """
    client = genai.Client(api_key=GEMINI_API_KEY)

    prompt = f"""Extract ALL eligibility rules from this mortgage program guideline.
The program is called "{program_name}".

Instructions:
- The document contains sections labeled "ACCURATELY EXTRACTED TABLES" — these are the most reliable source for loan amounts, LTV, CLTV, FICO, and other matrix values. ALWAYS prefer these over any other table data in the document.
- Create a separate tier entry for EACH ROW in the eligibility matrices. Each combination of transaction type, unit count/property type, and loan amount range is its own tier.
- For example, if the matrix shows Purchase/1 Unit/$806,501-$1,500,000/80% LTV and Purchase/1 Unit/$1,500,001-$2,000,000/75% LTV, those are TWO separate tiers.
- For QM/Non-QM status: ONLY set this if the guideline explicitly states QM or Non-QM status. If the document does not explicitly mention QM or Non-QM classification, use "Unknown". Do NOT infer QM status from product features like Interest Only — that determination requires domain expertise.
- Only extract values explicitly stated in the guideline. Use null for values not found.
- For transaction_types, use the exact terms from the guideline (e.g., "Purchase", "Rate/Term Refi", "Cash-Out Refi").
- For property_types, use the exact terms from the guideline (e.g., "SFR", "Condo", "PUD", "2-4 Units").
- For occupancy_types, use the exact terms from the guideline (e.g., "Primary Residence", "Second Home", "Investment").
- Capture any general program notes that apply across all tiers.
- Include the occupancy type (Principal Residence, Second Home, etc.) from the table headers in each tier.

Guideline content:
{markdown_text}"""

    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ProgramRules,
        ),
    )

    return ProgramRules.model_validate_json(response.text)
