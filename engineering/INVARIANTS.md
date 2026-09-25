# WAYFINDER Product Invariants

These are product properties, not named-route fixes.

- **WF-SPARK-001 — Useful success:** A sufficiently specified, feasible request with healthy required local services must produce at least one contract-valid, geographically verified, adoptable itinerary. A planning frame, placeholder, unverified route, or zero proposals is DEGRADED/FAILURE and cannot satisfy normal Spark acceptance.
- **WF-SPARK-002 — Traveler authority:** Explicit traveler start, end, duration, topology, required/excluded places, scope, and confirmed transport survive generation and adoption unchanged.
- **WF-SPARK-003 — Production parity:** Release success must exercise the same browser → server → local-model request path used by the packaged application. Mocked model output may prove UI behavior but cannot alone certify normal Spark success.
- **WF-ASYNC-001 — Stale work:** Contract/session changes cancel or discard stale asynchronous work. Transient checking state cannot become stranded durable truth.
- **WF-MODEL-001 — Local model scheduling:** WAYFINDER must remain correct with a single-worker local model. Concurrent model requests must not create deadlock/starvation or zombie work.
- **WF-REV-001 — Revision preservation:** Revision preserves the authoritative trip and all retained hard constraints while applying exactly the requested delta.
- **WF-PREC-001 — Precision authority:** Precision is a draft until one atomic save; downstream stages consume only committed authority.
- **WF-MAP-001 — Map authority:** Mapping uses the exact canonical occurrence sequence and traveler-confirmed transport. Success requires resolved required occurrences and legitimate route geometry/handoff; placeholders cannot count as success.
- **WF-DOC-001 — Document authority:** Documentation is bound to the exact authoritative trip/version and may not invent, omit, or contradict canonical route facts. Fallback output is DEGRADED, not normal success.
- **WF-PERSIST-001 — Continuity:** Save/reload/import/navigation preserve authoritative state and do not resurrect stale transient work.
- **WF-UI-001 — Critical controls:** Top-level status/actions remain visible and usable at supported desktop widths; health/error state is visually salient.
- **WF-LIFE-001 — Windows lifecycle:** Normal Exit releases WAYFINDER-owned processes, workers, sockets, runtime state, and package-directory handles so the extracted directory can be renamed and deleted.
- **WF-REL-001 — Artifact provenance:** A traveler ZIP exists only as output of the release workflow and is hash-bound to the source/evidence that passed the mandatory gates.
