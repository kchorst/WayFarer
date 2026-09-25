# WAYFINDER Release Manager Contract

WAYFINDER has exceeded 100 historical release-candidate iterations. That is a **process failure signal**, not an achievement. Internal iterations are development builds. No user-facing ZIP exists until every gate below passes against the exact packaged copy.

The assistant acts as Principal Engineer, QA Lead, Hostile Product Auditor, and Release Manager. The traveler performs final Windows acceptance and is never the primary QA system.

## 1. Specification / design gate

Before coding, identify the failure class, architectural owner, and general product invariant. Reject route-specific, geography-specific, prompt-specific, and UI-only workarounds for architecture/state defects. Preserve one canonical `TripAuthority`; downstream stages may derive from it but may not reinterpret it. Precision is a lossless draft with one atomic commit. Mapping and Documentation never secretly save or repair Precision.

## 2. Implementation gate

Make coherent architectural changes. Every significant change includes generalized validation, lifecycle/state-transition handling, regression coverage, and synchronized product documentation. Do not create a user-facing build during implementation.

## 3. Unit / integration gate

Test parsing, topology, boundaries, geography roles, duration, repeats, Open/confirmed state, transport, persistence, mapping/document contracts, and lifecycle. Exercise Prompt → Trip Basics → Spark → Adopt → Refine → Precision → Resolution → Mapping → Documentation, including save/reload/import and return-to-Spark continuity.

## 4. Invariant / property gate

Write the invariant before the test. Automatically vary geography, route length, loop/one-way/flexible/open-jaw topology, country/region/island/city/POI roles, repeats, Open/confirmed values, duration ranges, and transport. Each invariant must pass on at least three unrelated trip patterns. Mutation tests must deliberately violate each invariant and prove rejection. Named trips are regression examples only; they never prove the rule.

## 5. Performance / progress gate

Trip Basics target ≤2 seconds. Traveler-facing interpretation appears immediately. Speculative background work may run while basics are reviewed but never becomes canonical. First useful Spark route skeleton target ≤15 seconds after confirmation. Later ideas/enrichment are progressive. No interactive action may exceed 120 seconds. Contract changes cancel/discard stale work. Spark startup must also pass a single-worker local-model stress case: first-route generation and model-based contract extraction may not contend concurrently, and abandoning a fast-target request must cancel the upstream model request rather than leave zombie work queued.

## 6. Hostile QA gate

Adversarial cases must be different from implementation examples and combine stressors. Test degraded states including missing geography evidence, slow model, stale async responses, corrupt/missing PBF, partial references, navigation/reload during work, and shutdown during background work. QA's job is to reject the build. Every hostile failure creates a general invariant test plus at least one unrelated hostile regression.

## 7. Rendered adversarial walkthrough gate

Exercise the actual rendered UI, not only functions/components. Canonical journeys include vague named-route discovery, island loop, Paris→London one-way, multi-country Balkan/Baltic, multi-area islands, Revision, Precision, Mapping, Documentation, return to Spark, and persistence. Every canonical journey family must independently pass four rendered variants: **normal**, **contradictory**, **degraded/offline**, and **navigation/backtracking**. The four-variant matrix is separate, hash-bound release evidence; a broad adversarial suite cannot substitute for a missing family/variant cell. Verify controls, order, labels, state, warnings/blocks, progress, timing, and resulting route.

## 8. README / User Guide executable acceptance gate

`README.md` and `USER_GUIDE.md` are product contracts. Locate every documented control in the rendered app, perform the instruction, and verify the stated result. Planned behavior may not be documented as shipped. Any mismatch rejects the release. `GUIDE_ACCEPTANCE.json` must account for all 13 numbered User Guide sections and bind each section to passing rendered scenarios/matrix cells and/or the native-Windows lifecycle gate.

## 9. Windows lifecycle gate

Native Windows evidence is mandatory and must be external to the frozen ZIP so it can be produced after the ZIP hash is fixed. The evidence must bind the exact ZIP SHA-256, critical-source hash, and package-integrity-manifest hash. Linux/cross-platform lifecycle tests are useful regressions but cannot substitute for this gate.

Normal use has one launcher. Normal exit must stop WAYFINDER-owned Node/workers, close sockets/files, free the port, and release package-directory handles. Mandatory lifecycle proof: START → use app/background work → EXIT → no WAYFINDER process → port free → rename extraction → delete extraction. Failure to delete rejects the release. Recovery tooling is emergency-only.

## 10. Independent hostile Release Manager audit

Independently inspect invariants, hostile cases, rendered evidence, hashes, docs, lifecycle evidence, and package integrity. For every claimed fix ask: **What unrelated case could disprove this?** Search for duplicated assumptions, stale state, silent defaults, simultaneous-field hazards, geography-role confusion, stale async commits, inconsistent navigation snapshots, and map/document disagreement with authority. Evidence that only proves the original bug scenario is insufficient. Any plausible P0/P1 or ambiguous evidence means REJECTED or UNVERIFIED.

## 11. Exact-package verification gate

Only after internal gates pass: build the final ZIP, hash/freeze it, extract that exact ZIP into a clean directory, and rerun generalized regressions, hostile audit, rendered adversarial walkthrough, documentation checks, performance, lifecycle/deleteability, and integrity against that copy. Any later modification invalidates the evidence.

## 12. Final verdict gate

Only three statuses exist: `REJECTED`, `UNVERIFIED`, `READY FOR USER ACCEPTANCE`. Green test counts alone never produce READY. If any required gate cannot be executed, status is UNVERIFIED. Never hand the traveler a REJECTED or UNVERIFIED ZIP.

## Current semantic release invariants

Release validation is general, not Baltic-specific:

- country/region/island coverage is not a route occurrence unless the traveler explicitly makes it one;
- confirmed one-way/open-jaw trips do not close back to their start;
- confirmed loops close structurally;
- proposal titles cannot contradict confirmed topology;
- unrequested repeated stops are rejected except the structural closing occurrence of a loop;
- confirmed start/end/duration/required/excluded constraints are preserved;
- unavailable geographic evidence may leave an idea readable, but adoption is blocked until the route can be verified;
- unrelated generated/mutated route patterns must falsify violations independently of named regression journeys.

## Communication

Keep development updates short and infrequent. Report only a major blocker, release rejection, or final release status. The user's Windows test is simply whether the released app works as specified.
