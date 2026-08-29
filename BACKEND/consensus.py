from __future__ import annotations

from collections import Counter


CONSENSUS_FIELDS = (
    "hecvat_compliance",
    "policy_alignment",
    "overall_status",
    "initial_likelihood",
    "initial_impact",
    "initial_risk_rating",
    "residual_likelihood",
    "residual_impact",
    "residual_risk_rating",
)


def _signature(run: dict) -> tuple:
    return tuple(run.get(field) for field in CONSENSUS_FIELDS)


def decide(runs: list[dict]) -> dict:
    total = len(runs)
    if total < 1:
        raise ValueError("at least one assessment run is required")
    majority = total // 2 + 1

    valid_indexes = [
        index for index, run in enumerate(runs)
        if run.get("run_valid") is True
    ]
    signatures = [_signature(runs[index]) for index in valid_indexes]
    counts = Counter(signatures)
    winning_signature, agreement = counts.most_common(1)[0] if counts else (None, 0)

    if agreement < majority:
        return {
            "consistency_status": "NO_CONSENSUS",
            "manual_review_status": "REQUIRED",
            "consensus": None,
            "agreeing_runs": [],
            "dissenting_runs": [index + 1 for index in range(total)],
            "valid_run_count": len(valid_indexes),
            "invalid_run_count": total - len(valid_indexes),
        }

    agreeing = [
        index for index in valid_indexes
        if _signature(runs[index]) == winning_signature
    ]
    consensus = {
        field: runs[agreeing[0]].get(field)
        for field in CONSENSUS_FIELDS
    }
    return {
        "consistency_status": f"CONSENSUS_{agreement}_OF_{total}",
        "manual_review_status": "NOT_REQUIRED",
        "consensus": consensus,
        "agreeing_runs": [index + 1 for index in agreeing],
        "dissenting_runs": [
            index + 1 for index in range(total) if index not in agreeing
        ],
        "valid_run_count": len(valid_indexes),
        "invalid_run_count": total - len(valid_indexes),
    }
