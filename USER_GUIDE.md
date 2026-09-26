# WAYFINDER User Guide

This guide describes the controls and behavior that exist in the current WAYFINDER rebuild package. It is intentionally limited to shipped functionality; it does not describe planned controls as though they already work.

## 1. Start and exit WAYFINDER

On Windows:

1. Extract the WAYFINDER folder to a normal local folder.
2. Double-click **`WAYFINDER.cmd`**.
3. WAYFINDER starts its local server in the background and opens `http://127.0.0.1:4198/` by default. You do not need to keep a launcher window open.
4. When finished, click **Exit WAYFINDER** in the top bar. WAYFINDER stops background work, closes the local server, releases the port, and ends its Node process.
5. If you simply close the last WAYFINDER browser tab/window, the app automatically shuts the local server down after a short grace period.

After either normal exit path, the extracted WAYFINDER folder should be movable, renameable, and deletable after shutdown completes.

<!-- RM-SINGLE-APP-LIFECYCLE -->

`SUPPORT/RECOVER-WAYFINDER.cmd` exists only for emergency recovery of a stuck or legacy WAYFINDER process. It is not a normal step.

If `WAYFINDER.cmd` reports that Node.js is missing or too old, install Node.js 20+ before trying again.

## 2. Configure Settings

Click **Settings** in the top bar. The current Settings screen supports:

- **Local AI endpoint** — leave blank to let WAYFINDER try common local endpoints on ports 8080, 1234, and 11434.
- **Model name** — optional model override; blank allows detection when the server reports a model.
- **Kiwix / local references** — the local Kiwix/reference endpoint. The default is `http://127.0.0.1:8091`.
- **Local gazetteer endpoint** — optional local geocoder.
- **MapQuest API key** — optional. The saved secret is retained locally and is not displayed back in full.
- **Offline map library folder** — the folder containing existing Geofabrik/OpenStreetMap `*.osm.pbf` files. On Windows, **Browse…** opens the native folder picker.
- **Allow online geocoding fallback when online** — enables/disables web geocoding fallback.
- **Remove saved MapQuest key** — removes the locally stored MapQuest key when settings are saved.

Click **Save settings** after changing configuration. Click **Refresh status** to recheck local AI, references, MapQuest configuration, and offline-map status.

The home screen has separate live badges for the **Local model** and **Kiwix / local references**. Kiwix is not hidden inside Settings: if the reference server is unavailable, the home badge says it is offline. Click **Check local services** to recheck both services without opening Settings.

<!-- RM-HOME-SERVICE-HEALTH -->
**Local-service health acceptance:** with Kiwix unavailable, the home screen must visibly report **Kiwix / local references offline** while the local-model badge remains independent; after Kiwix becomes available, **Check local services** must update the badge to **Kiwix running**.

## 3. Create a trip with Spark

<!-- RM-FRESH-SPARK-PROMPT -->
A genuinely new trip opens with an empty Spark composer. WAYFINDER does not restore orphaned legacy/test composer text that is not owned by a valid saved exploration or active trip. The Spark textarea also disables browser autocomplete so unrelated previously typed phrases are not injected into a fresh request.

In **1 · SPARK**, describe the whole trip you are imagining in normal language. You may be specific or deliberately vague. Include hard requirements only when you actually know them.

Examples:

> I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.

> I heard about a walk or trek in Japan, something like a Shikoku route.

Click **Explore trip ideas**.

### Confirm trip basics — the fast sanity check

WAYFINDER immediately performs a lightweight deterministic read of the prompt and opens **Confirm trip basics** before it shows Spark proposals. The browser is given a render opportunity before model/network itinerary work starts, so this confirmation card is the first Spark result the traveler sees rather than a long blank wait. It confirms the trip backbone, not the detailed itinerary.

At the top of the card, **What WAYFINDER understood immediately** summarizes the recognized Destination(s), Start, Finish, Duration, and Shape. A separate **Background preparation** line shows that contract checking/route ideation is continuing and may add safe signals such as interests or required places while you review. These are traveler-facing facts/status, not hidden model reasoning.

The editable basics are:

- **Destinations / trip area**
- **Start**
- **Finish**
- **Duration**
- **Trip shape** — Open, Loop, One-way, Open-jaw, Flexible, or Circumnavigation

Each value also shows where it came from. A value you typed is labeled **You specified**. A well-established route convention may appear as a clearly labeled suggestion. An unknown value may remain **Open — suggest for me** or **Open — show me possibilities**. Open is a valid traveler choice; a confirmed Open field also overrides any background-extractor guess for that field; WAYFINDER does not require you to invent an answer just to proceed.

For a Loop, Finish can remain linked to the chosen Start. Generic Trip Basics stays generic: pilgrimage/temple controls do not appear on ordinary trips. When WAYFINDER confidently recognizes a named route such as the Shikoku 88-Temple Pilgrimage, any route-specific option appears only inside that recognized-route context and is clearly labeled as a suggestion.

If the basics are wrong, edit the fields directly or choose **Edit original request**. When they are acceptable, click **Confirm & build ideas**. The confirmed values become the hard Spark contract; Spark may vary open fields, but it may not silently violate confirmed boundaries, duration, topology, required places, or exclusions.

When the traveler names multiple destination areas, WAYFINDER preserves all of them. For example, `Sardinia and Corsica` is displayed as **Sardinia + Corsica** and both areas become required coverage scopes; a route that covers only one island is rejected.

Countries/regions named as coverage are never turned into literal route stops merely to satisfy the request. For example, a five-week `Tallinn → Riga` trip to see Estonia, Latvia, and Lithuania keeps those three countries as geographic coverage scopes; the route spine must use actual cities/ports/route anchors. Spark also rejects a one-way proposal whose title claims it is a loop, and rejects repeated route stops unless the repeat is the structural closing occurrence of a confirmed loop or the traveler explicitly requested a revisit.

<!-- RM-BALTIC-ONE-WAY-SCOPE -->
<!-- RM-GENERIC-SEMANTIC-MATRIX -->
Release acceptance also exercises the same route-shape and scope rules on unrelated one-way and loop journeys. A named regression trip is never treated as proof of the general rule.

<!-- RM-GEOGRAPHY-FAIL-CLOSED -->
When a proposed route stop cannot be verified against the confirmed geographic scope, WAYFINDER may keep that idea visible for review/copying, but **Refine**, **Route visual**, and **Build document** remain disabled until the route can be verified. Geographic uncertainty never makes the confirmed destination contract optional.

<!-- RM-BASICS-CONTRADICTION -->
If edited Trip Basics contradict each other (for example, different start/finish while **Loop** is selected), WAYFINDER blocks confirmation instead of generating ideas from an impossible contract.

<!-- RM-STALE-SPARK-CANCEL -->
If you edit the original request or start a different Spark exploration while background work is still running, work from the superseded exploration is cancelled/discarded and cannot appear in the new trip ideas.



While you review **Confirm trip basics**, WAYFINDER may already prepare possible routes in the background using the provisional interpretation. This speculative work never changes the current authoritative trip and is not shown as a valid idea until the basics are confirmed. If your confirmation matches the provisional contract, matching background work can be reused. If you change a confirmed basic, stale speculative work is discarded/cancelled and Spark continues from the new confirmed contract.

### Spark progress and ideas

After confirmation, **Confirmed Spark contract** continues to show traveler-facing planning signals such as scope, start, finish, duration, route shape, transport, required/optional/excluded places, and interests when those are known. These are visible product facts and progress/context; WAYFINDER does **not expose hidden chain-of-thought**.

Spark has a 120-second interactive ceiling, with a Release Manager target of **15 seconds or less from Trip Basics confirmation to the first visible route skeleton**. Spark requests one minimal route skeleton first, validates its geographic/contract structure, displays it immediately, and enriches summaries/themes afterward in the background. Raw half-JSON/token fragments are never displayed. While the full Traveler Contract is still being checked, a visible skeleton can be read/copied but adoption controls remain disabled; adoption becomes available only after the contract is verified.

<!-- RM-SERIAL-LOCAL-MODEL -->
WAYFINDER treats the local model as a potentially single-worker service. First-route generation gets exclusive priority before deeper model-based contract extraction starts, so two local-model jobs do not queue behind each other during Spark startup. When a fast-target request is abandoned, WAYFINDER cancels the upstream local-model request as well; abandoned work must not continue consuming the model until the 120-second ceiling.

Each concept can offer these actions:

- **Refine this idea** — adopt the concept as the canonical trip and open Refine.
- **Save copy** — copy the concept summary/route to the clipboard. This does not create a separate saved trip inside WAYFINDER.
- **Route visual** — adopt the concept and move to Route visual. If coordinates have not been resolved yet, use **Resolve route** on that screen.
- **Build document** — adopt the concept and move to Documentation.

A Spark proposal is only a suggestion until you choose/adopt it. Adoption itself is validated; a proposal that cannot become a valid `TripAuthority` is withheld instead of becoming live and being repaired downstream.

After you adopt a concept, WAYFINDER collapses the large Spark gallery into a compact **Selected trip concept** summary so the workspace has room for Refine, Precision, Route visual, and Documentation. Click **Show ideas / Change concept** to reopen the gallery. Click **Hide ideas** to collapse it again without changing the canonical trip. The workspace also provides **← Spark ideas & original request** so you can return from any downstream stage.

A new Spark exploration is separate from the active trip. If you edit the Spark request and choose **Explore trip ideas** again, the current authoritative trip, its original prompt, and its revision history remain attached to that trip until you explicitly adopt a replacement concept. New exploratory cards do not silently become the active trip.

### Start without Spark

Click **Start in Precision** to create a blank authoritative trip and enter the trip manually in Precision. If a trip is already active, WAYFINDER asks before replacing it.

## 4. Refine the selected trip

Open the **Refine** tab after a concept has been adopted.

At the top of Refine, **Original Spark request** shows the exact traveler request attached to the current authority, and **Current selected route** shows the route you are revising. This context stays visible so a revision is not detached from the idea the traveler actually chose.

Use **Back to Spark ideas** to reopen the existing alternatives. Use **Edit original request** when you want to load the original request back into the Spark composer and explore a different set of ideas. Neither action changes the current authoritative trip by itself.

Under **What do you want to change?**, type only the requested delta, for example:

> Change the departure city and keep everything else unless I explicitly ask otherwise.

Click **Apply revision**.

Revision is intended to apply a delta to the current canonical trip rather than regenerate an unrelated trip. Explicit boundary language such as entering/starting in one place and departing/ending in another is treated as boundary intent; if that changes a former loop into an open route, WAYFINDER applies the topology/boundary transition as one coherent revision transaction rather than trying to remove a still-active loop boundary first. The revision log shows the accepted change summary and the number of typed commands applied.

If the current Precision state is invalid, Revision is rejected instead of being applied on top of an invalid authority.

## 5. Use Precision as the authoritative editor

Open the **Precision** tab to inspect or edit the current canonical trip. Precision uses one lossless **Trip Draft**. Changing fields edits the draft; **Save Precision** validates and commits that complete draft atomically. Mapping, Documentation, and Revision continue to use the last saved `TripAuthority` and do not secretly save Precision for you.

The current Precision screen exposes:

- a derived **Start / Finish** summary from the first and last canonical route rows; there is no second independent boundary editor;
- Topology: Flexible, Loop, One-way, Open-jaw, or Circumnavigation;
- Duration type: Not specified, Flexible, Exact, or Range, with the matching day fields;
- Start date, End date, and Season/timing note;
- trip-wide **Transport** and **Traveler confirmed trip-wide transport**;
- Geographic scopes, one per line (commas remain part of qualified place names);
- Home/origin, separate from route stops;
- Experiences, one per line;
- Canonical route occurrences;
- Per-leg transport overrides and explicit confirmation state;
- Traveler commitments;
- **Excluded places (not routed)**;
- other exclusions/constraints;
- Scoped transport requirements using `scope | mode`;
- Traveler/passport context.

### Edit the canonical route

In **Canonical route occurrences**:

- Click **+ Add stop** to add another occurrence.
- Edit a stop label directly. A qualified name such as `Springfield, Missouri` stays one place; commas do not split route rows.
- Use ↑ / ↓ to change occurrence order.
- Use × to delete an occurrence.
- Choose an active-route disposition: required, optional, or transit only.
- To exclude a place from the trip, expand **Traveler commitments, exclusions & passports** and add it under **Excluded places (not routed)**. Place exclusions are canonical constraints separate from the active route.
- **Other exclusions / constraints** is for non-place restrictions or notes.
- Choose a stay rule: flexible, exact, at least, at most, or no stay; enter days where applicable.

Start and finish are derived from route order. A Loop may have a separate terminal closure occurrence referring to the same physical place as the start. Repeated visits remain distinct occurrences with stable identities. Changing a required/optional route occurrence reconciles the matching place constraint so the route and hard-constraint model cannot silently contradict one another.

### Transport

Use the trip-wide **Transport** field for the main choice. Check **Traveler confirmed trip-wide transport** only when that mode is actually confirmed by the traveler.

Per-leg overrides can be selected in **Per-leg transport overrides**. **Any** means use the trip-wide choice when one is confirmed. If editing the route splits or changes a leg that had an explicit override, WAYFINDER may propagate the prior mode to the affected new legs but marks those legs **Needs confirmation**. Saving the route does not silently reconfirm them; check their confirmation boxes only after reviewing them.

### Save or discard the draft

Click **Save Precision** to commit one coherent Trip Draft to canonical `TripAuthority`. Topology, route boundaries, occurrences, duration/range, timing, constraints, and transport are validated as the intended final state rather than replayed as independent commands. This is why a Loop can be changed to Flexible/One-way with a different last row without being trapped by the old loop rule.

Click **Discard unsaved changes** to return Precision to the last saved authority. If you move to Refine, Route visual, or Documentation with unsaved Precision changes, the stage tells you it is still using the last saved trip. Actions that require canonical state are blocked until the draft is saved or discarded; those stages never commit the draft behind your back.

Impossible cross-field state is rejected at save/import—for example an end date before the start date, a duration range contradicted by selected dates, required minimum stays longer than the trip, a required place also excluded, or a required place missing from the route.

## 6. Resolve the route

**Resolve route** is available in both **Precision** and **Route visual**. Use it after the canonical route is ready. This means the Spark **Route visual** shortcut does not require you to navigate backward just to begin coordinate resolution.

WAYFINDER attempts to attach coordinates/evidence to each canonical occurrence without changing the occurrence's meaning or order.

After resolution, the Route visual shows how many occurrences are resolved. If a place has multiple credible map matches, WAYFINDER presents choices in Route visual and waits for you to choose instead of silently guessing.

If a stop remains unresolved, the stop remains in the canonical route. The map must not draw a fake direct connection across that unresolved occurrence.

## 7. Use Route visual

Open **Route visual**.

The internal visual is based on the current canonical occurrence order. Resolved portions may be drawn even when another occurrence is unresolved, but unresolved gaps are not supposed to be bridged as though they were valid legs.

The current Route visual provides:

- **Resolve route** — attach coordinates/evidence to the canonical occurrences without changing their meaning or order.
- **Route with MapQuest** — fetch provider geometry when a MapQuest key is configured and the canonical transport/route is eligible.
- **Load offline map** — render against configured offline map data.
- **Open same route in Google Maps** — external Google handoff when the route can be represented faithfully.
- **Open same route in MapQuest** — external MapQuest handoff when eligible.

### Transport and provider handoff

WAYFINDER does not silently choose a transport mode for provider directions. If transport is unconfirmed or the provider cannot faithfully represent the canonical route, a provider action may be disabled/withheld while the canonical internal route remains intact.

For a large Google route, WAYFINDER may show multiple **Segment** links so canonical stops are not silently dropped to fit provider waypoint limits.

### Offline `*.osm.pbf` maps

Use **Settings → Offline map library folder** to select the folder containing your existing Geofabrik/OpenStreetMap `*.osm.pbf` extracts, then save Settings.

You do not need to download a second XYZ/vector-tile map library for the raw-PBF workflow.

For detailed raw-PBF rendering/routing, all canonical route stops must be resolved first. This prevents WAYFINDER from inventing road geometry through an unresolved stop. Missing map coverage should be reported as a map limitation rather than deleting or rewriting the trip.

## 8. Build the travel document

Open **Documentation**. Before building, choose the sections you want under **Document sections**:

- **Route at a glance**
- **Overview**
- **Stop-by-stop planning notes**
- **Transport notes**
- **Practical preparation**

At least one section must remain selected. These choices are first-class document preferences: they persist with the working trip, survive reload/export/import, and control the deterministic baseline, local-model enrichment, and timeout fallback. Changing the choices invalidates the previously built document so the next **Build document** uses the new plan.

Click **Build document**. WAYFINDER freezes the current authority version and the current document plan. It immediately creates complete fallback content for every selected section, then may gather local references and use the local model to enrich that same structure within the interactive budget.

### Sources and citations

When local Wikivoyage/Wikipedia/Kiwix evidence is available, WAYFINDER assigns deterministic source identifiers such as `[S1]`. Destination notes that use that evidence carry the relevant identifier, and the finished document appends a **Sources / References** section listing the actual local source title/provider and source URL when available. Citation identifiers come from the gathered evidence; the model is not permitted to manufacture them.

Canonical trip facts such as route order, traveler-selected duration, exclusions, and confirmed transport come from `TripAuthority` rather than an external source. Time-sensitive schedules, fares, opening hours, and entry requirements are not accepted as unsourced current facts; they are removed or left as instructions to verify against current official sources.

If reference research or model enrichment cannot finish within the limit, every selected section remains structurally complete using concise fallback content. If **Stop-by-stop planning notes** is selected, no canonical occurrence may disappear because enrichment timed out. The time limit may reduce richness, not selected-section completeness.

Click **Copy** to copy the displayed document to the clipboard.

## 9. Save, export, import, and start over

WAYFINDER automatically persists the working trip in browser local storage for the local WAYFINDER origin.

#<!-- RM-EXPORT-IMPORT -->
## Export trip

Click **Export trip** to download a validated WAYFINDER JSON trip file. Export is available when an authoritative trip exists.

### Import trip

Click **Import trip** and choose a previously exported WAYFINDER JSON file. WAYFINDER validates imported canonical state before making it live. An invalid/corrupt trip should be rejected rather than silently becoming the current trip.

### New trip

Click **New trip** and confirm to clear the locally saved working trip and reload the application. Runtime Settings are stored separately and are not intentionally cleared by this action.

## 10. What works offline

When the corresponding local resources are already installed/running, the product is designed so the core workflow can remain local-first:

- local-model Spark and Revision;
- Precision editing;
- Kiwix/local-reference research;
- Documentation;
- internal mapping from installed offline map data.

Google Maps, MapQuest online routing/handoff, and online geocoding fallback require network access and/or provider configuration.

Missing offline-map coverage should not prevent non-map trip research.

## 11. Time limits and status feedback

Interactive actions have a 120-second ceiling. The UI reports working stages and elapsed time for long-running model/document/map operations.

For Documentation, hitting the ceiling must preserve every traveler-selected section as a structurally complete document with fallback content where enrichment was unfinished. Source references already gathered remain deterministic and traceable.

Large raw-PBF preparation may continue as bounded background work when it does not block the rest of the interactive workflow.

## 12. Troubleshooting

### The top badge says Local model offline

- Open **Settings** and verify the local AI endpoint/model.
- Make sure the local model server is running.
- If the endpoint field is blank, WAYFINDER attempts common localhost endpoints; use a specific endpoint if auto-detection is not finding your server.
- Click **Refresh status**.

### Local model is reachable but model setup is needed

The server responded but did not supply a usable model name. Enter the model name in **Settings** if your local server requires an explicit model selection.

### Route visual shows unresolved stops

Click **Resolve route** again in either Precision or Route visual after correcting ambiguous or misspelled place labels. If WAYFINDER presents candidate buttons, choose the intended place. Do not expect provider directions or detailed raw-PBF routing to invent coordinates for an unresolved stop.

### Load offline map is unavailable or reports missing coverage

- Open **Settings**.
- Confirm **Offline map library folder** points to the folder containing the required `*.osm.pbf` extract(s).
- Click **Save settings** and **Refresh status**.
- Resolve all canonical stops if detailed raw-PBF routing is waiting for complete resolution.
- Add the missing country/region extract to your library when coverage is genuinely absent.

### MapQuest is unavailable

Open **Settings** and configure a MapQuest API key. Even with a key, MapQuest routing can remain disabled when the canonical route/transport cannot be represented faithfully.

### Google/MapQuest links are withheld

Check the transport state in Precision. Provider direction handoffs may be withheld when transport is unconfirmed or incompatible with a whole-route provider request. This does not remove the canonical route.

### A saved trip will not load/import

WAYFINDER validates saved/imported canonical state. If a stored state fails canonical invariants, it is not made live. Correct the source file only if you understand the schema; otherwise use a known-good export.

## 13. Verify the package

`VERIFY-WAYFINDER.cmd` verifies the already packaged copy locally: regression tests, syntax, runtime smoke, hostile audit, and complete-tree integrity. It does not manufacture a release certificate. `GUIDE_ACCEPTANCE.json` assigns every numbered guide section to concrete rendered evidence and, where Windows behavior is involved, the native-Windows lifecycle certificate; a section with no executable evidence owner blocks release. Final qualification is produced only by the frozen GitHub Windows release workflow after the exact ZIP, rendered evidence, and native-Windows lifecycle evidence all agree on the same release and hashes.

These are the required release journeys for this build:

<!-- RM-IMMEDIATE-TRIP-BASICS -->
**Immediate Trip Basics:** entering `Give me a tour of Corsica.` and clicking **Explore trip ideas** must render **Confirm trip basics** immediately, show Corsica in **What WAYFINDER understood immediately**, leave unknown start/finish/duration open, and show no Spark idea before confirmation.

<!-- RM-BACKGROUND-FEEDBACK -->
**Background feedback + progressive delivery:** while the Corsica basics are being reviewed, **Background preparation** must visibly report work and add extracted safe signals. After confirmation, at least one complete validated concept must become visible while later alternatives are still being prepared.

<!-- RM-CORSICA-SCOPE -->
**Corsica geographic scope:** a Corsica-only prompt must not show an off-island Saint-Tropez route as a valid concept, and the broad label `Corsica` must not be inserted as a literal route stop.

<!-- RM-SARDINIA-CORSICA -->
**Sardinia + Corsica multi-area contract:** `Plan a trip for me for 3 weeks around Sardinia and Corsica.` must immediately preserve both destination areas, keep 21 days, show no irrelevant pilgrimage/temple control, produce a first route skeleton within the 15-second Release Manager target, and reject concepts that fail to cover either island.

<!-- RM-SHIKOKU -->
**Shikoku recognition:** the vague Shikoku walking prompt must identify the Shikoku 88-Temple Pilgrimage and clearly label Temple 1 / Temple 88 as traditional suggested boundaries rather than traveler-specified facts; duration may remain open.

<!-- RM-SICILY-OPEN -->
**Sicily loop with open gateway:** `I have three weeks to do a loop tour of Sicily.` must preserve 21 days + Loop while keeping the unspecified gateway open for Spark to vary.

<!-- RM-PALERMO-LOOP -->
**Explicit Palermo loop:** `Start and finish in Palermo` must place Palermo in both boundary fields and keep Loop.

<!-- RM-CRETE-LOOP -->
**Crete loop:** a loop tour of Crete must identify Crete + Loop while allowing an unspecified start/finish to remain open.

<!-- RM-PARIS-LONDON -->
**Paris → London one-way:** Paris must remain Start, London Finish, and the trip shape One-way.

<!-- RM-SPARK-RETURN -->
**Traveler continuity:** after adopting a concept, the large idea gallery must collapse; Refine must show the exact **Original Spark request**; **Back to Spark ideas**, **Edit original request**, and the downstream **← Spark ideas & original request** path must return without silently replacing the active trip.

<!-- RM-PRECISION-ATOMIC -->
**Atomic Precision:** a saved Tallinn → Tartu → Tallinn loop must be able to become Tallinn → Tartu → Riga + Flexible in one coherent save, without the old loop boundary trapping the edit.

<!-- RM-ROUTE-RESOLUTION -->
**Route resolution:** **Resolve route** from Route visual must resolve the saved canonical occurrences through the resolution layer, keep their order/identity, and render the canonical map when coordinates are available.

<!-- RM-DOCUMENT-CITATIONS -->
**Document contract:** Documentation must expose persisted section choices and a generated evidence-backed document must contain deterministic `[S#]` citations plus **Sources / References** when local source evidence is used.

<!-- RM-SLOW-MODEL-FIRST-SKELETON -->
**Slow-model first-useful-skeleton gate:** the rendered release test deliberately delays the first Spark stream to near the 15-second target and makes that first skeleton geographically invalid. WAYFINDER must reject the invalid skeleton and still surface a different, complete, geographically valid route skeleton within 15 seconds of Trip Basics confirmation.

<!-- RM-GUIDE-EXECUTABLE-CONTROLS -->
**Executable guide-control walkthrough:** release acceptance opens rendered **Settings**, edits and saves the documented runtime fields, refreshes status, runs Spark confirmation, exercises concept copy/adoption and Refine, exercises Precision add/discard/save controls, enters Route visual and checks the documented mapping/provider controls, and builds Documentation with the documented section controls. Export/import persistence remains exercised by its dedicated rendered journey. Windows launcher/exit/deleteability remains the separate native-Windows lifecycle gate.



<!-- RM-FOUR-VARIANT-MATRIX -->
**Four-variant rendered matrix:** every canonical journey family must independently pass four rendered variants—**normal**, **contradictory**, **degraded/offline**, and **navigation/backtracking**. Release evidence is rejected if any family/variant cell is missing, failing, stale, or bound to different critical source bytes.

If any required rendered journey is missing/failing, if this guide no longer contains its acceptance marker, or if critical product files change after rendered evidence is produced, the release is blocked. A passing test count alone is never a release verdict.
