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
- Each distinct eligibility matrix/tier should be a separate tier entry.
- Identify the QM/Non-QM status of the program. Use "QM", "Non-QM", or "Both".
- Only extract values explicitly stated in the guideline. Use null for values not found.
- For transaction_types, use the exact terms from the guideline (e.g., "Purchase", "Rate/Term Refi", "Cash-Out Refi").
- For property_types, use the exact terms from the guideline (e.g., "SFR", "Condo", "PUD", "2-4 Units").
- For occupancy_types, use the exact terms from the guideline (e.g., "Primary Residence", "Second Home", "Investment").
- Capture any general program notes that apply across all tiers.

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
