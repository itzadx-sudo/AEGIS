from __future__ import annotations


FIELDS = (
    "overall_status",
    "initial_likelihood",
    "initial_impact",
    "initial_risk_rating",
    "residual_likelihood",
    "residual_impact",
    "residual_risk_rating",
)
POSITIVE_STATUSES = {"GAP", "PARTIAL"}


def compare(predictions: list[dict], references: list[dict]) -> dict:
    predicted = {item.get("control_id"): item for item in predictions if item.get("control_id")}
    reference = {item.get("control_id"): item for item in references if item.get("control_id")}
    comparable_ids = sorted(predicted.keys() & reference.keys())
    field_counts = {field: {"matches": 0, "compared": 0} for field in FIELDS}
    false_positives = []
    false_negatives = []
    inconsistent = []
    exact_matches = 0

    for control_id in comparable_ids:
        actual = reference[control_id]
        result = predicted[control_id]
        if result.get("consistency_status") == "NO_CONSENSUS":
            inconsistent.append(control_id)
            continue
        all_fields_match = True
        for field in FIELDS:
            if actual.get(field) is None or result.get(field) is None:
                all_fields_match = False
                continue
            field_counts[field]["compared"] += 1
            if result[field] == actual[field]:
                field_counts[field]["matches"] += 1
            else:
                all_fields_match = False
        if all_fields_match:
            exact_matches += 1

        predicted_positive = result.get("overall_status") in POSITIVE_STATUSES
        actual_positive = actual.get("overall_status") in POSITIVE_STATUSES
        if predicted_positive and not actual_positive:
            false_positives.append(control_id)
        if actual_positive and not predicted_positive:
            false_negatives.append(control_id)

    assessed_count = len(comparable_ids) - len(inconsistent)
    return {
        "reference_controls": len(reference),
        "prediction_controls": len(predicted),
        "comparable_controls": len(comparable_ids),
        "assessed_controls": assessed_count,
        "inconsistent_controls": inconsistent,
        "field_agreement": {
            field: {
                **counts,
                "rate": (
                    round(counts["matches"] / counts["compared"], 4)
                    if counts["compared"] else None
                ),
            }
            for field, counts in field_counts.items()
        },
        "exact_control_matches": exact_matches,
        "overall_accuracy": (
            round(exact_matches / assessed_count, 4) if assessed_count else None
        ),
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "accuracy_claim_allowed": bool(reference and assessed_count),
    }
