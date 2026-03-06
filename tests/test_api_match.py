"""Integration tests for /api/match and /api/explain Flask endpoints."""

import json
from unittest.mock import MagicMock, patch

import pytest

from matching.models import (
    CriterionResult,
    CriterionStatus,
    OverallStatus,
    ProgramResult,
    TierResult,
)
from server import app


@pytest.fixture
def client():
    """Flask test client with testing mode enabled."""
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def valid_listing():
    """Valid RentCast listing payload."""
    return {
        "price": 500000,
        "propertyType": "Single Family",
        "state": "CA",
        "county": "Los Angeles",
        "countyFips": "06037",
        "latitude": 34.0522,
        "longitude": -118.2437,
        "bedrooms": 3,
        "bathrooms": 2.0,
        "squareFootage": 1500,
    }


@pytest.fixture
def mock_program_results():
    """Pre-built list of ProgramResult for mocking match_listing."""
    return [
        ProgramResult(
            program_name="Thunder",
            status=OverallStatus.ELIGIBLE,
            matching_tiers=[
                TierResult(
                    tier_name="Tier 1",
                    status=OverallStatus.ELIGIBLE,
                    criteria=[
                        CriterionResult(
                            criterion="property_type",
                            status=CriterionStatus.PASS,
                            detail="Single Family matches SFR",
                        ),
                        CriterionResult(
                            criterion="loan_amount",
                            status=CriterionStatus.PASS,
                            detail="Price $500,000 allows loan in range",
                        ),
                        CriterionResult(
                            criterion="location",
                            status=CriterionStatus.PASS,
                            detail="No location restrictions",
                        ),
                        CriterionResult(
                            criterion="unit_count",
                            status=CriterionStatus.PASS,
                            detail="Single Family has 1 unit(s)",
                        ),
                    ],
                )
            ],
            best_tier="Tier 1",
        ),
    ]


# --- /api/match endpoint tests ---


class TestMatchEndpoint:
    """Tests for POST /api/match."""

    @patch("server.match_listing")
    @patch("server.load_programs")
    def test_match_valid_listing_returns_200(
        self, mock_load, mock_match, client, valid_listing, mock_program_results
    ):
        """POST /api/match with valid listing returns 200 and program results."""
        mock_match.return_value = mock_program_results

        resp = client.post(
            "/api/match",
            data=json.dumps(valid_listing),
            content_type="application/json",
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert "programs" in data
        assert "eligible_count" in data
        assert len(data["programs"]) == 1
        assert data["eligible_count"] == 1

    def test_match_empty_body_returns_400(self, client):
        """POST /api/match with empty body returns 400."""
        resp = client.post(
            "/api/match",
            data=json.dumps(None),
            content_type="application/json",
        )

        assert resp.status_code == 400
        data = resp.get_json()
        assert data["success"] is False
        assert "error" in data

    @patch("server.match_listing")
    @patch("server.load_programs")
    def test_match_response_has_per_criterion_breakdown(
        self, mock_load, mock_match, client, valid_listing, mock_program_results
    ):
        """Response programs contain per-criterion breakdown."""
        mock_match.return_value = mock_program_results

        resp = client.post(
            "/api/match",
            data=json.dumps(valid_listing),
            content_type="application/json",
        )

        data = resp.get_json()
        program = data["programs"][0]
        assert "matching_tiers" in program
        tier = program["matching_tiers"][0]
        assert "criteria" in tier
        assert len(tier["criteria"]) == 4
        criterion = tier["criteria"][0]
        assert "criterion" in criterion
        assert "status" in criterion
        assert "detail" in criterion

    @patch("server.match_listing")
    @patch("server.load_programs")
    def test_match_makes_zero_llm_calls(
        self, mock_load, mock_match, client, valid_listing, mock_program_results
    ):
        """POST /api/match makes zero calls to google.genai."""
        mock_match.return_value = mock_program_results

        with patch("google.genai.Client") as mock_genai:
            resp = client.post(
                "/api/match",
                data=json.dumps(valid_listing),
                content_type="application/json",
            )

            assert resp.status_code == 200
            mock_genai.assert_not_called()

    @patch("server.match_listing")
    @patch("server.load_programs")
    def test_match_response_is_json_serializable(
        self, mock_load, mock_match, client, valid_listing, mock_program_results
    ):
        """Match response program results have model_dump()-compatible structure."""
        mock_match.return_value = mock_program_results

        resp = client.post(
            "/api/match",
            data=json.dumps(valid_listing),
            content_type="application/json",
        )

        data = resp.get_json()
        # Should be JSON serializable (we got a valid response)
        assert data is not None
        # Verify structure matches ProgramResult.model_dump()
        program = data["programs"][0]
        assert program["program_name"] == "Thunder"
        assert program["status"] == "Eligible"
        assert program["best_tier"] == "Tier 1"


# --- /api/explain endpoint tests ---


class TestExplainEndpoint:
    """Tests for POST /api/explain."""

    @patch("server.explain_match")
    def test_explain_returns_200(self, mock_explain, client, valid_listing):
        """POST /api/explain with valid payload returns 200 with explanation."""
        mock_explain.return_value = "This property qualifies for Thunder program."

        resp = client.post(
            "/api/explain",
            data=json.dumps(
                {
                    "program_name": "Thunder",
                    "listing": valid_listing,
                    "tier_name": "Tier 1",
                }
            ),
            content_type="application/json",
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert "explanation" in data
        assert isinstance(data["explanation"], str)

    def test_explain_missing_program_name_returns_400(self, client, valid_listing):
        """POST /api/explain with missing program_name returns 400."""
        resp = client.post(
            "/api/explain",
            data=json.dumps({"listing": valid_listing, "tier_name": "Tier 1"}),
            content_type="application/json",
        )

        assert resp.status_code == 400
        data = resp.get_json()
        assert data["success"] is False


# --- explain_match function tests ---


class TestExplainMatch:
    """Tests for the explain_match function."""

    @patch("matching.explain.genai")
    @patch("matching.explain.query_program_info")
    def test_explain_match_calls_chromadb(self, mock_query, mock_genai):
        """explain_match calls query_program_info for ChromaDB context."""
        mock_query.return_value = {
            "documents": [["Program guideline text here"]],
            "metadatas": [[{"program_name": "Thunder"}]],
        }
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value = MagicMock(
            text="Explanation text"
        )
        mock_genai.Client.return_value = mock_client

        from matching.explain import explain_match

        explain_match("Thunder", {"price": 500000}, "Tier 1")

        mock_query.assert_called_once()
        call_args = mock_query.call_args
        assert "Thunder" in call_args[1].get("program_name", "") or "Thunder" in str(
            call_args
        )

    @patch("matching.explain.genai")
    @patch("matching.explain.query_program_info")
    def test_explain_match_calls_gemini(self, mock_query, mock_genai):
        """explain_match calls Gemini Flash generate_content."""
        mock_query.return_value = {
            "documents": [["Program guideline text here"]],
            "metadatas": [[{"program_name": "Thunder"}]],
        }
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value = MagicMock(
            text="Explanation text"
        )
        mock_genai.Client.return_value = mock_client

        from matching.explain import explain_match

        explain_match("Thunder", {"price": 500000}, "Tier 1")

        mock_genai.Client.assert_called_once()
        mock_client.models.generate_content.assert_called_once()

    @patch("matching.explain.genai")
    @patch("matching.explain.query_program_info")
    def test_explain_match_returns_string(self, mock_query, mock_genai):
        """explain_match returns string explanation text."""
        mock_query.return_value = {
            "documents": [["Program guideline text here"]],
            "metadatas": [[{"program_name": "Thunder"}]],
        }
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value = MagicMock(
            text="This property qualifies because..."
        )
        mock_genai.Client.return_value = mock_client

        from matching.explain import explain_match

        result = explain_match("Thunder", {"price": 500000}, "Tier 1")

        assert isinstance(result, str)
        assert len(result) > 0
