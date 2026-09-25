# WAYFINDER

### Spark route-semantics release gate

Release acceptance proves route semantics as **general invariants**, not by replaying one named trip. Property/mutation tests vary unrelated geographies and topology, and rendered adversarial journeys include both named regressions and unrelated route patterns. Country/region/island coverage must remain scope rather than route occurrences; proposal titles must agree with confirmed topology; and unrequested repeats are rejected except structural loop closure.


WAYFINDER is a local-first / offline-first travel planner built around one canonical `TripAuthority`. The traveler can move from an idea to a refined trip, an authoritative route, mapping, and a travel document without Google Maps or MapQuest becoming the source of trip meaning.

### Spark responsiveness and Trip Basics

After **Explore trip ideas**, Trip Basics renders before itinerary generation. After confirmation, the Release Manager target is **≤15 seconds to the first validated route skeleton**; description/theme enrichment happens afterward. Multi-area requests (for example Sardinia + Corsica) preserve every confirmed area as required coverage. Generic Trip Basics never shows route-specific controls unless a named route was confidently recognized.

WAYFINDER treats a local model as potentially **single-worker**. The first Spark route gets model priority; deeper model-based request extraction does not compete with that first route request. If a fast-target Spark request is abandoned or times out, cancellation is propagated through the WAYFINDER server to the upstream local model so stale work cannot keep the model occupied and push the traveler into the 120-second ceiling.

## Current package status

**Development status: UNVERIFIED. Do not treat this tree as a user release until the exact frozen ZIP passes the native Windows lifecycle/deleteability gate.**

This rebuild package contains the synchronized Spark prompt → **Confirm trip basics** → Spark ideas → Refine → Precision → Route visual → Documentation workflow. It includes immediate traveler-visible interpretation feedback, speculative background ideation, a hard confirmed Spark contract, geographic-scope validation with adoption blocked when geography is unverified, a lossless atomic Precision Trip Draft, persisted document-section preferences, source-backed document references, progressive complete-concept delivery, and compact Spark presentation after a concept is adopted.

WAYFINDER now uses a Release Manager gate. Unit/regression tests are necessary but cannot promote a build by themselves. The exact build must also pass generalized invariant/property tests, an independent hostile audit, guide-defined rendered Chromium traveler journeys in `ACCEPTANCE_JOURNEYS.json`, the server lifecycle/deleteability test, and complete-package integrity. Rendered evidence is cryptographically bound to the shipped UI/core/server/launcher/docs before a build can be marked ready for user acceptance.

## Requirements

- Windows for the supplied `.cmd` launchers and native offline-map folder picker.
- Node.js 20 or newer.
- A local OpenAI-compatible model server for Spark, natural-language Revision, and LLM document enrichment.
- Optional local Kiwix/Wikivoyage/Wikipedia service for local reference enrichment and reference-assisted place resolution.
- Optional local gazetteer service.
- Optional Geofabrik/OpenStreetMap `*.osm.pbf` files for detailed offline maps.
- Optional MapQuest API key for MapQuest routing/handoff.

Google Maps and MapQuest are optional online views. They are not required for WAYFINDER's canonical trip state.

## Quick start on Windows

1. Extract the WAYFINDER folder.
2. Double-click **`WAYFINDER.cmd`**.
3. The launcher starts the local server in the background and opens WAYFINDER in your browser. The launcher window does not need to remain open.
4. The home screen shows separate **Local model** and **Kiwix / local references** status badges. Use **Check local services** for an immediate recheck; use **Settings** for endpoints, MapQuest, and offline maps.
5. When finished, click **Exit WAYFINDER** inside the app, or simply close the last WAYFINDER browser tab/window. WAYFINDER then shuts down its local server and releases the extracted folder.

`SETUP-WAYFINDER.cmd` remains an optional first-run shortcut. Normal configuration is available in the app.

### One-app lifecycle and deleteability

`WAYFINDER.cmd` is the normal launcher. There is no separate normal Stop application. The browser registers itself with the local WAYFINDER server; **Exit WAYFINDER** stops the server immediately, and closing the last registered WAYFINDER window automatically stops it after a short grace period. Shutdown cancels background work, closes HTTP connections, releases the port, removes runtime control state stored outside the extracted folder, and ends the WAYFINDER Node process.

`SUPPORT/RECOVER-WAYFINDER.cmd` is emergency recovery only for a stuck/legacy process. It is not part of normal start/stop use.

Release management must prove both normal exit paths against an extracted copy: launcher → browser session → in-app Exit → free port → rename/delete, and launcher → browser close → automatic shutdown → free port → rename/delete.

For complete traveler instructions, see **[USER_GUIDE.md](USER_GUIDE.md)**.

## What the current UI supports

The shipped interface currently contains these user actions:

- **Explore trip ideas** — immediately open a small **Confirm trip basics** sanity check from the natural-language request. Full route ideation may begin speculatively in the background while the traveler reviews the basics.
- **Confirm & build ideas** — confirm destination/area, start, finish, duration, and trip shape where known; open fields may remain open for Spark to vary. The confirmed values become the hard Spark contract. Complete validated concepts then appear progressively while remaining alternatives continue generating; the UI shows traveler-facing contract signals rather than hidden chain-of-thought.
- **Start in Precision** — create a blank authoritative trip without Spark.
- **Refine this idea** — adopt a Spark concept and continue to conversational Revision.
- **Save copy** — copy a Spark concept to the clipboard.
- **Route visual** — adopt a concept and move to mapping.
- **Build document** — adopt a concept and move to Documentation.
- **Apply revision** — request a delta change to the selected trip while the original Spark request and current route remain visible in Refine.
- **Save Precision** — save the Precision editor as canonical `TripAuthority` state.
- **Resolve route** — resolve canonical route occurrences without changing their meaning/order.
- **Route with MapQuest** — request MapQuest geometry only when configured and eligible.
- **Load offline map** — use installed offline map data; raw `*.osm.pbf` rendering is supported.
- **Open same route in Google Maps** / **Open same route in MapQuest** — optional provider handoffs when the canonical route can be represented faithfully.
- **Document sections** — choose Route at a glance, Overview, Stop-by-stop planning notes, Transport notes, and/or Practical preparation; the selection persists with the trip.
- **Build document** / **Copy** — create and copy a travel document from a frozen authority snapshot. When local reference evidence is used, the document includes deterministic `[S#]` citations and a **Sources / References** section.
- **Export trip** / **Import trip** — move a validated WAYFINDER trip as JSON.
- **New trip** — clear the locally saved working trip.
- **Check local services** — recheck the local model and Kiwix/reference server directly from the home screen.
- **Settings** — configure local AI, Kiwix/references, gazetteer, MapQuest, offline map library, and online geocoding fallback.
- **Exit WAYFINDER** — stop the local WAYFINDER process cleanly from inside the app.

## Spark workspace behavior

**Confirm trip basics** is a first-class stage between the prompt and visible Spark proposals. Its deterministic first pass is rendered before model itinerary work begins and is designed to appear immediately rather than after Spark generation. The card includes **What WAYFINDER understood immediately** so the traveler can see the recognized area, start, finish, duration, and shape at once. Each field can be traveler-confirmed, a clearly labeled route-convention suggestion, or intentionally **Open**. Open is not an error. If local geography evidence is insufficient for a proposed route, the idea may remain readable/copyable but its adoption actions stay disabled until the route can be verified. Confirmed Open fields remain genuinely open and override any speculative extractor guess for the same essential field. For example, a traveler may confirm `Sicily · 3 weeks · Loop` while leaving the starting gateway open for Spark to vary.

While that card is on screen, **Background preparation** reports what is happening and can add safe traveler-facing signals such as interests, required/optional/excluded places, transport signals, and commitments as they are extracted. WAYFINDER may simultaneously perform speculative route ideation. Speculative proposals belong only to that exploration session; they never alter `TripAuthority`. Matching work is reused after confirmation, while work built from superseded basics is cancelled/discarded.

Spark streams **validated route skeletons first**, not raw token fragments. The first usable route should appear quickly while summaries/themes enrich in the background and additional alternatives continue generating. A skeleton may be read/copied while final contract checks finish, but it cannot be adopted until the confirmed Traveler Contract has validated it. **Confirmed Spark contract** displays explicit traveler-facing facts/signals such as destinations, boundaries, duration, topology, transport, and required places; this is progress/context, not model chain-of-thought. A proposal that violates the confirmed contract or cannot validate as an adoptable authority is withheld.

After a concept is adopted, the large Spark gallery collapses into a compact **Selected trip concept** summary so Refine, Precision, Route visual, and Documentation receive the working space. Use **Show ideas / Change concept** or **← Spark ideas & original request** to reopen the active trip's Spark exploration. A new Spark exploration is kept separate from the active trip until a replacement concept is explicitly adopted.

## Refine and Precision continuity

Refine displays the **Original Spark request** and **Current selected route** above the revision field. Its example text is intentionally geography-neutral; no Italy/Bologna example is injected into an Estonia or other unrelated trip. **Back to Spark ideas** and **Edit original request** provide a direct return path without silently discarding the current authority. Adopting a genuinely different trip starts that trip's own revision history.

Precision is a lossless **Trip Draft** over one saved `TripAuthority`. Start/Finish are derived from the first/last canonical route rows rather than duplicated in independent boundary fields. Duration ranges remain ranges, qualified place names remain intact, and route/transport edits preserve stable occurrence identity. **Save Precision** validates and commits the complete intended state atomically. Route edits that split a leg with an explicit transport mode require traveler reconfirmation; ordinary save does not silently confirm the propagated mode.

Mapping, Documentation, Resolution, and Revision do not call a hidden Precision save. If the Precision draft is dirty, canonical actions use the last saved authority and require the traveler to save or discard the draft before an action that depends on the new state. Cross-field authority validation rejects contradictory required/excluded places, invalid date order, date/duration conflicts, and minimum stays that exceed the trip budget.

## Offline maps

WAYFINDER uses the traveler's existing Geofabrik/OpenStreetMap country or region `*.osm.pbf` files directly. A second XYZ/vector-tile library is not required.

In **Settings**, choose the folder containing the installed `.osm.pbf` files and save. WAYFINDER catalogs that folder and uses route-focused background preparation for the internal map. Missing PBF coverage degrades detailed offline mapping only; it must not erase the trip or prevent local research/Documentation.

Detailed raw-PBF routing waits until all canonical route occurrences have coordinates so WAYFINDER does not invent a connection across an unresolved stop.

## Persistence

- The working trip is stored in browser `localStorage` for the WAYFINDER localhost origin.
- Runtime settings are stored separately in the user's local application-data configuration directory (on Windows, normally `%APPDATA%\WAYFINDER\settings.json`).
- The saved MapQuest secret is not displayed back in the Settings UI.
- **Export trip** creates a JSON copy of the validated working state.
- **New trip** clears the working trip; it does not intentionally remove runtime settings.

## Documentation behavior

The traveler selects the document sections to include. Those preferences are stored with the working trip and drive a deterministic `DocumentPlan`; the same plan controls the immediate baseline, model enrichment, timeout fallback, save/reload, and import/export behavior.

Documentation first creates a **complete deterministic document floor for every selected section** from a frozen authority snapshot. Local references and the local model may then enrich that structure within the interactive budget. If local Wikivoyage/Wikipedia/Kiwix evidence is used, WAYFINDER assigns deterministic `[S#]` identifiers, carries them into destination notes, and appends a **Sources / References** catalog. The local model is not allowed to invent source identifiers.

The 120-second ceiling limits enrichment, not structural completeness. If enrichment stops or fails, every selected section remains complete and every canonical route occurrence remains represented whenever Stop-by-stop planning notes is selected. The application must not intentionally finish with a mid-route/truncated document merely to satisfy the time limit.

## Verification

For the packaged source checks, run:

```text
VERIFY-WAYFINDER.cmd
```

or:

```bash
npm run check
```

These checks cover the source/regression/runtime-smoke/integrity suite that is wired into `package.json`. Browser acceptance remains a separate end-to-end acceptance activity and should not be inferred solely from a passing unit/regression count.

## Development rule

Do not repair WAYFINDER with route-specific hotfixes. A discovered failure is evidence of a broader ownership, invariant, or product-contract weakness and must be fixed at the appropriate architectural boundary with generalized regression coverage.

## Release Manager verification

`VERIFY-WAYFINDER.cmd` runs regression/source/runtime/integrity checks and the Release Manager gate. The gate requires rendered traveler evidence for every required journey in `ACCEPTANCE_JOURNEYS.json`, and those journey markers must also exist in `USER_GUIDE.md`. Evidence is rejected if the shipped UI/core/docs changed afterward.
