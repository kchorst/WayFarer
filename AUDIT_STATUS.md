# WAYFINDER — Release Manager audit status

**Release:** `WAYFINDER-2026-09-25-DEVELOPMENT-GATE`  
**Status:** **UNVERIFIED / DEVELOPMENT ONLY.** All non-Windows gates must pass, then the exact frozen ZIP must produce native Windows lifecycle evidence before this status can become READY FOR USER ACCEPTANCE.

## Release-manager findings closed

- The former scenario-specific Baltic patch model was removed as proof of correctness. Route semantics are now validated by general invariants/property mutations across unrelated labels, route lengths, topology, duration ranges, geography roles, repeats, required/excluded places, and Unicode place identity.
- Raw Spark candidates that omit or contradict confirmed topology/duration, use broad administrative geography as route stops, repeat unconfirmed occurrences, or insert scope labels into the route are rejected before normalization can repair them. POI/landmark occurrences are allowed only when explicitly traveler-owned as a route occurrence.
- Geographic verification is tri-state: VERIFIED / UNVERIFIED / CONTRADICTED. Explicit start/end anchors participate in coverage proof, country identity uses authoritative ISO country identity where available, proven mismatch is rejected, and insufficient local evidence blocks adoption.
- Trip Basics contradictions are blocked before generation, and stale Spark work is cancelled/discarded when the traveler edits or replaces the exploration.
- The fast-first Spark path requests a minimal skeleton before enrichment and has a 15-second first-route target inside the 120-second interaction ceiling. Rendered hostile timing delays the first stream by 12.5 seconds, makes that first skeleton invalid, and requires a different complete validated skeleton before 15 seconds. A traveler-found Jamaica failure exposed single-worker starvation: Spark had been issuing extraction and generation concurrently, and browser cancellation did not cancel the server's upstream model request. The current development build serializes first-route generation before model extraction, propagates client disconnect/abort to the upstream model fetch, and has both rendered single-worker and real HTTP cancellation regressions.
- Generic Trip Basics is free of route-specific controls; named-route conventions are data-driven and contextual.
- Export/import persistence, Precision atomicity, resolution, offline-map degradation, document preferences/citations, and Spark return/backtracking are exercised in rendered acceptance.
- Normal Windows lifecycle remains one-launcher/one-app behavior with in-app Exit and last-window shutdown; stopped extraction must be renameable/deletable. READY additionally requires external native-Windows evidence bound to the exact ZIP SHA-256, critical-source hash, and package-integrity manifest.

## Independent hostile evidence

The Release Manager hostile audit owns a separate expected-outcome oracle instead of using product validation as its own proof. It exercises hundreds of deterministic generated/mutated semantic cases, unrelated boundary prompts, geography mismatch/unverified controls, route-length variation, and duration-range boundaries. Named trips remain regression examples only.

The rendered Chromium suite exercises normal, contradictory, degraded, stale-work/backtracking, persistence, mapping, and documentation behavior against the actual shipped HTML/CSS/ES modules with deterministic local-service mocks. Required broad journeys are declared in `ACCEPTANCE_JOURNEYS.json`; a separate hash-bound canonical-family matrix requires normal, contradictory, degraded/offline, and navigation/backtracking variants for every family. `GUIDE_ACCEPTANCE.json` assigns all 13 numbered User Guide sections to executable rendered evidence and/or the native-Windows lifecycle gate.

## Release verdict rule

This release is not handed to the traveler unless the final ZIP is frozen, clean-extracted, and that exact copy passes: architecture/unit/integration checks, generalized invariant/property tests, hostile audit, rendered adversarial walkthrough, README/User Guide contract checks, performance gates, lifecycle/deleteability, complete-tree integrity, and the hash-bound Release Manager gate.

Final Windows use by the traveler remains final acceptance, not primary QA.
