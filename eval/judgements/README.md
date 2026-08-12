# Search Judgements

This directory contains the ground truth dataset for evaluating the quality of our search implementation (`GET /discovery/search`). 

We maintain a versioned judgement set to continuously measure our lexical baseline and catch regressions before they are merged. If a PR modifies the retrieval or ranking algorithms, CI will evaluate the search against this judgement set and fail if precision or nDCG regressions breach our defined thresholds.

## Judgement Format

Our judgements are defined in `queries.json`. The file contains a list of query objects with graded relevance.

```json
[
  {
    "query": "weather forecast",
    "description": "User wants to check current weather conditions",
    "expected": {
      "https://example.com/weather-api": 3,
      "https://example.com/finance-api": 0
    }
  }
]
```

- **query**: The exact search string sent to the catalog.
- **description**: Why the user is searching for this and what their intent is.
- **expected**: A map of URLs to their relevance score (0-3).
  - `3`: Highly relevant, exactly what the user wants.
  - `2`: Relevant, solves the problem but perhaps not perfectly.
  - `1`: Marginally relevant.
  - `0`: Irrelevant, or actively harmful (e.g., keyword stuffed).

## Contribution Guide

We actively accept additions to this judgement set, especially cases that our current search handles poorly! 

To add a new judgement:
1. Identify a realistic query agents might use.
2. Determine the expected best results based on the existing `eval/fixtures/catalog.json`.
3. If no resources match the query, specify an empty `expected` map (empty-result cases are vital!).
4. Include adversarial cases (e.g., a listing that stuffed its description with irrelevant keywords).
5. Open a PR with your additions to `queries.json`. We will merge judgements even if they make our metrics drop—accuracy of measurement is more important than a high score.

## Methodology & Limitations

Our evaluation methodology relies on a small, curated fixture catalog (`eval/fixtures/catalog.json`) and a set of human-authored judgements.

**Limitations:**
- **Author Bias:** The judgements were written by the same developers who wrote the search algorithm, over a catalog we manually curated. This introduces obvious bias.
- **Scale:** The fixture catalog only contains a handful of resources, so it does not perfectly simulate the noise and scale of the live public network.
- **Context:** Agent intents are highly contextual, but our judgement set evaluates queries statically without conversational context.
