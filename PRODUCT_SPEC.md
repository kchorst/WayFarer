# WAYFINDER Product Purpose and Specification

## Purpose

WAYFINDER is a **local-first travel planning application** that helps a traveler move from a rough idea to a usable, mapped, documented trip without the application silently taking control away from the traveler.

It must support simple prompts (for example, “tour Greece”) and complex prompts (multi-country, cross-border, island, regional, or intercontinental trips with duration, required places, stay rules, transport preferences, and traveler/passport context).

## Core workflow

### 1. Spark — suggestions, not authority
- Accept natural-language traveler ideas, even when incomplete or imaginative.
- Immediately after **Explore trip ideas**, show a compact **Confirm trip basics** stage before visible proposals. This is neither Revision nor Precision; it is a fast sanity check of the request's essential backbone.
- The initial Trip Basics pass must be deterministic/synchronous where practical and target roughly 0–2 seconds rather than waiting for full local-model itinerary generation.
- Trip Basics covers only essential structure: destination/recognized trip, start, finish, duration, and route shape. Each field must distinguish traveler-provided, inferred/route-convention suggestion, and intentionally open state. **Open** is a valid choice and must not be converted into an unstated hard constraint. When the traveler confirms an essential field as Open, that Open state overrides any background-extractor guess for the same field; the extractor cannot secretly harden it.
- Well-established route conventions may prefill suggestions when confidence is high, but this recognition must use a general/data-driven convention mechanism rather than geography-specific control-flow patches. The UI must label provenance, and convention values become hard Spark constraints only after traveler confirmation.
- While Trip Basics is being reviewed, WAYFINDER may extract the remaining Traveler Contract and speculatively ideate routes in the background. Speculative work is exploration-session state only: it cannot mutate `TripAuthority`, cannot be shown/adopted before confirmation, and must be cancelled/discarded when its contract fingerprint no longer matches the confirmed basics. Matching work may be reused for faster visible Spark results.
- The confirmed Trip Basics plus the rest of the verified Traveler Contract are a **hard generation/adoption gate**. Contract-extraction failure, explicit contradictions, hard-constraint violations, or an invalid candidate authority block that proposal rather than being repaired downstream.
- Produce useful alternative trip concepts quickly and normally aim for three distinct alternatives.
- Deliver Spark progressively at the **complete-concept** boundary: once one proposal is structurally valid against the confirmed contract, show it while later alternatives continue. Do not expose malformed JSON or raw half-generated token fragments as a trip idea.
- While Spark works, expose traveler-facing **confirmed contract / planning signals** (for example scope, start, finish, duration, transport, required places, interests). These are progress/context summaries, not hidden chain-of-thought.
- If a valid proposal is adopted before later alternatives finish, those later alternatives may continue filling the same exploration gallery but may not change the adopted authority.
- After a proposal is adopted, collapse the large Spark gallery into a compact selected-concept summary; reopening alternatives is an explicit traveler action and collapsing them never changes authority.
- Maintain separate identities for the **active trip session** and any **new Spark exploration session**. Re-running Spark must not contaminate the active trip's prompt, proposal gallery, revision history, or authority. The existing trip remains authoritative until a new concept is explicitly adopted.
- A persistent downstream control must return the traveler to the active trip's Spark ideas and original request.
- A Spark proposal may infer reasonable ideas, but inferred content is a suggestion, not traveler-owned truth.
- Do not require final-map-level verification before showing an exploratory proposal.
- Ask a clarification only when ambiguity materially prevents useful planning.

### 2. Revision — conversational delta
- The traveler can modify the currently selected trip in natural language.
- Revision means “keep the current trip and change these things.”
- Unchanged traveler constraints survive.
- New revision instructions become edits to the same authority model used by Precision.
- Refine must display the exact **Original Spark request** attached to the current authority and the current selected route, so the traveler can see what is being revised. Geography-specific placeholder examples must not appear as though they belong to an unrelated trip.
- Explicit start/end/departure language is boundary intent. Interdependent topology, boundary, and duplicate-occurrence changes are applied in a safe transactional order rather than failing because an old loop boundary is still temporarily active.

### 3. Precision — explicit traveler authority
Precision is the authoritative trip editor, but the UI edits a separate lossless **Trip Draft** until the traveler explicitly saves. It should expose the complete current trip specification, including at minimum:
- trip duration, including exact/range/flexible/not-specified semantics, and/or dates/season;
- geographic scope(s): country, region, island, multi-country, etc.;
- route topology: loop, one-way, open-jaw, flexible/circumnavigation where relevant;
- one canonical ordered occurrence list whose first and last rows define Start/Finish; there must not be a second competing Start/End editor;
- visitation requirements per place: required/optional/transit-only on active route occurrences, plus first-class excluded-place constraints that are not silently kept in the routed spine;
- stay requirements per place: flexible, exactly N, at least N, no more than N, no stay;
- required/preferred/excluded experiences and interests;
- trip-wide transport preferences;
- scoped transport requirements and per-leg overrides;
- traveler-owned commitments and exclusions;
- traveler/passport context where relevant;
- home/origin context separated from trip stops;
- any other hard constraints needed downstream.

The draft must preserve canonical occurrence identity, qualified place labels, duration ranges, provenance, constraints, and transport state when fields are unchanged. Route mutations must reconcile stale leg IDs. If an explicit leg override is propagated across a newly split/changed leg, the resulting leg is unconfirmed until the traveler explicitly reconfirms it. A normal Save must never silently re-confirm it.

**Save Precision** performs one atomic validated commit from Trip Draft → TripAuthority. The intended final topology, boundaries, occurrences, duration/timing, constraints, and transport are validated together rather than replayed as sequential UI commands. Structural loop closures must not become accidental duplicate visits when a traveler intentionally converts a loop to an open route with a different end. Required/optional/excluded constraints must reconcile with route edits rather than creating contradictory duplicate ownership.

Cross-field blockers include at minimum: invalid date order; date/duration contradiction; required minimum/exact stays exceeding the trip's maximum duration; required and excluded same place; required place missing from the active route; malformed populated precision rows. Persistence/import performs the same canonical invariant validation.

Mapping, Documentation, coordinate Resolution, and Revision consume the **saved authority** only. They never call a hidden Precision save. Unsaved draft state must be explicitly saved or discarded before an action that depends on those edits.

### 4. Mapping
- Mapping consumes the selected authoritative trip; it does not reinterpret the traveler.
- Traveler chooses/approves transport mode before mode-specific routing, schedules, or fares become authoritative.
- Support internal/offline PBF mapping and external map-provider handoff where available.
- Preserve stop identity and occurrence order.
- Cross-border, multi-country, island, and intercontinental routes are first-class.
- Partial map resolution should not erase valid trip state.
- Coordinate resolution must be reachable from both Precision and Route Visual so a Route Visual shortcut never strands the traveler in a stage that cannot make itself usable.
- Map presentation should fit the actual route at a useful scale.

### 5. Documentation
- Generate a rich travel document from the authoritative trip.
- Stream useful prose as it is produced.
- Never invent hard traveler facts, missing route stages, transport choices, schedules, or fares.
- If transport is unselected, document transport neutrally rather than presenting mode-specific claims as fact.
- A document must never become structurally incomplete because the local model is slow. WAYFINDER creates a complete deterministic document floor immediately from the frozen authority, covering every canonical occurrence and required section, then lets the local model enrich that complete structure.
- If enrichment is interrupted or reaches the interactive ceiling, keep every section and canonical stop in the document; unfinished sections fall back to concise safe notes instead of disappearing or ending mid-trip.
- Ground practical content in available local references where possible.
- Traveler-selected document sections are first-class persisted document preferences. Preferences produce a deterministic `DocumentPlan` that controls baseline generation, enrichment, timeout fallback, reload, and export/import; the Documentation UI edits that state rather than owning a transient checkbox list.
- Local-reference evidence used for destination facts must remain traceable. Assign deterministic source identifiers from actual gathered evidence, preserve them through enrichment, and append a Sources / References catalog. The local model must never invent citations.
- Time-sensitive schedules, fares, opening hours, and entry/visa rules require current verified evidence or an explicit verification instruction; unsupported current claims are not silently accepted.

## Clarification

Clarification is a safety valve, not the default interaction pattern.
- Ask only when a missing/contradictory fact materially changes what can be usefully planned.
- Prefer Spark alternatives for ordinary preference trade-offs.
- A genuine traveler contradiction may block progression until answered.

## Local-first resources

The product is designed to use:
- a local OpenAI-compatible LLM endpoint;
- local Wikivoyage/Wikipedia-style reference content;
- local place/gazetteer resources;
- local/offline OSM/PBF map data;
- external map handoff/provider APIs where configured.

## Product invariants

1. There is exactly one authoritative traveler trip object after selection/refinement; unsaved Precision state is a separate draft, never a second authority.
2. Spark proposals and speculative ideation are exploration-session state, not authoritative trip state until a validated proposal is explicitly adopted.
3. No layer silently rewrites explicit traveler constraints.
4. Geographic scope is not the same thing as a literal settlement anchor.
5. A normal loop may repeat its start only as the terminal closure.
6. Local POIs/markets/neighborhoods are experiences unless the traveler explicitly makes them route stops.
7. Missing gazetteer coverage alone must not make a plausible Spark idea disappear; however, an unverified route is review-only and cannot be adopted until its confirmed geographic scope can be verified.
8. Advisory quality judgments must not be confused with traveler-constraint violations.
9. Mapping and Documentation consume authority; they do not become competing authority owners.
10. Novel ordinary prompts must be usable without destination-specific code changes.
11. Trip Basics may recognize a small number of well-established named route conventions, but route-specific recognition can only propose clearly labeled defaults; it cannot bypass the general Traveler Contract or authority invariants.
12. Active-trip state and new Spark-exploration state are isolated until explicit adoption.
13. A fresh Spark composer is empty. Free-floating/legacy composer text is not durable trip state; prompt restoration requires ownership by a valid saved exploration or active trip.
13. Downstream stages never commit an unsaved Precision draft as a side effect.

## Offline-first operating contract

Offline travel research is a primary product mode, not a degraded fallback.

- Spark, Revision, Precision, local-reference research, Documentation, and the internal map must remain useful without internet access when the corresponding local resources are installed.
- Google and MapQuest are optional online downstream views/providers. Neither is required for the internal map or for core trip research.
- The internal map must accept the traveler's existing Geofabrik/OpenStreetMap country or region extracts (`*.osm.pbf`) directly as the map-library source.
- The traveler must not be required to find, download, understand, or manually maintain a second XYZ/vector-tile PBF library.
- If internal conversion, indexing, caching, or reduced-detail preparation is needed, WAYFINDER owns that work and keeps it transparent to the traveler.
- A user-selected map-library folder is authoritative. WAYFINDER catalogs its `.osm.pbf` files, reads their header bounds, selects the smallest installed set that covers the canonical route, and supports multi-extract trips.
- Missing offline map coverage must not block non-map offline research. It should be reported clearly so the traveler can add the missing region while online.
- Partial resolution never permits the mapper to invent a connection across an unresolved canonical occurrence.

## Settings and runtime-status contract

Essential local configuration belongs inside WAYFINDER Settings and persists locally across launches.

Settings must expose at minimum:
- local LLM endpoint and detected/selected model;
- local Wikipedia/Wikivoyage/Kiwix endpoint;
- local gazetteer endpoint when used;
- MapQuest API key configuration without displaying the saved secret;
- offline `.osm.pbf` map-library folder, including Windows folder browsing;
- online geocoding fallback preference.

The normal UI must show truthful live runtime state. The home screen must report the local model and Kiwix/local-reference service independently, and must provide an explicit local-services recheck without requiring Settings. When a local model is available, the model status must update to show it is running and identify the model when known. When Kiwix is unavailable, that degraded state must remain visible on the home screen. Long-running actions must show their current stage and elapsed time rather than a generic spinner or silent wait.

## Interactive performance contract

WAYFINDER is an interactive planning application. No interactive action may silently run for more than two minutes.

- Normal interactive target: approximately 5–30 seconds.
- Heavy local-model or local-reference target: preferably under 60 seconds.
- Absolute interactive ceiling: 120 seconds for Spark, Revision, route resolution, interactive mapping preparation, and Documentation.
- At the ceiling, stop bounded work, preserve the best safe usable result, report what completed, and let the traveler continue. For Documentation specifically, the result must remain structurally complete rather than being a truncated partial trip.
- Do not use hidden generate/reject/repair/re-evaluate loops. Use at most one bounded repair/retry for a failed or incomplete model stage, then return the best usable safe result.
- Reuse unchanged resolution and reference results; cache repeated local searches; cancel stale work when authority changes.
- Documentation must show a complete authority-derived outline immediately, before local-reference or LLM enrichment finishes. Reference gathering receives a bounded sub-budget so it cannot consume the full interactive window. Model enrichment uses compact context/token budgets and progressively replaces fallback sections only with complete safe prose. A timeout may reduce richness, never route coverage or section completeness.
- Large `.osm.pbf` cataloging/indexing/conversion may continue as explicit background preparation beyond two minutes only when it does not block Spark, Revision, Precision, Documentation, or use of the already-available canonical map.
- Map workers and other heavy background tasks must be cancelable and resource-bounded.


### Runtime lifecycle / clean shutdown contract

- `WAYFINDER.cmd` is the single normal Windows launcher. It starts the local server in the background and opens the browser; no launcher console must remain open for normal use.
- The app itself owns normal shutdown. **Exit WAYFINDER** must cancel/terminate background PBF/catalog workers and outbound runtime work, close the HTTP listener and active connections, release the port, remove the external runtime control record, and end the Node process.
- Closing the last registered WAYFINDER browser tab/window must also trigger automatic graceful shutdown after a short grace period. Reload/navigation must not create a false shutdown race.
- Starting the same build again reuses the existing server instead of creating another process. Starting a different live build remains blocked.
- Live process-control metadata stays outside the extracted application directory.
- A stopped extraction must be renameable and deletable. Release verification must prove both in-app Exit and last-window-close lifecycle paths against an extracted package copy.
- `SUPPORT/RECOVER-WAYFINDER.cmd` is emergency recovery only. Normal travelers must not need a second Stop application.
- A legacy WAYFINDER listener may be force-stopped only after verifying that the target service is WAYFINDER; unrelated Node processes must never be killed.

### Release-management contract

- Internal iterations are development builds, not release candidates.
- `README.md` and `USER_GUIDE.md` are part of the product contract. Required guide journeys are enumerated in `ACCEPTANCE_JOURNEYS.json`.
- Before a build can be handed to the traveler, the exact critical UI/core/server/launcher/docs must pass rendered Chromium journeys, the lifecycle/deleteability gate, and produce hash-bound `RENDERED_ACCEPTANCE.json` evidence.
- Unit/regression counts cannot promote a build by themselves. The exact final ZIP must be unpacked cleanly and pass release and integrity verification again.
- If rendered verification is unavailable or fails, release status remains UNVERIFIED/REJECTED.

## UI continuity contract

A clean rewrite may replace internal architecture, but it must not silently remove essential traveler controls or change the established workflow without product justification.

The primary traveler workflow remains recognizable as Spark prompt / Confirm trip basics / Spark ideas / Refine / Precision / Route Visual / Documentation, with compact controls and visible progress. Full Spark alternatives occupy the page while the traveler is choosing; after adoption they collapse to a compact selected-concept summary so downstream Mapping and Documentation receive the working space. Settings, offline-map configuration, provider controls, and saved-trip controls are product capabilities, not implementation details that may disappear during a rewrite.

## User documentation contract

`README.md` and `USER_GUIDE.md` are shipped product artifacts, not release notes written after the fact.

- The packaged README must link to the packaged user guide.
- Instructions must describe only functionality that exists in the same package.
- Control names, workflow order, locations, persistence behavior, and known product boundaries must match the shipped UI/runtime.
- When functionality changes, the guide and README change in the same product change.
- A package fails acceptance if its usage instructions materially disagree with the functionality.

## Spark fast-first contract (Release Manager)

- Trip Basics must render immediately after Spark submission.
- Generic fields are Destinations/area, Start, Finish, Duration, and Trip shape. Route-specific options are contextual to a confidently recognized named route only.
- Multi-area destination input is preserved as separate required-coverage scopes.
- After confirmation, the first validated route skeleton target is <=15 seconds; skeleton generation is first-phase and descriptive enrichment is second-phase/background.
- The full interaction still has a 120-second hard ceiling.
- A route skeleton shown while secondary Traveler Contract extraction is finishing is non-adoptable until the contract is verified.

## Spark route-semantics invariant

Geographic coverage and route occurrences are different types. Countries, regions and islands confirmed as destination coverage must not be inserted as literal stops unless the traveler explicitly names them as route anchors. Spark candidates must not contradict confirmed topology in their titles, and repeated route occurrences require explicit traveler revisit intent except for the structural closing occurrence of a confirmed loop. These invariants are release-gated through general property/mutation tests across unrelated geographies and topology plus rendered adversarial journeys. The Baltic one-way journey is a regression example, not proof of the general rule.
