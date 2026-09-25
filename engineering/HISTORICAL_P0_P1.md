# Historical P0/P1 Regression Ledger

Historical named routes are witnesses, not implementation targets.

| Witness | Failure class | Invariant(s) |
|---|---|---|
| Jamaica ordinary two-week request | Healthy Spark path produced no itinerary / timed out | WF-SPARK-001, WF-MODEL-001 |
| Mallorca ordinary two-week request | Planning/degraded frame appeared instead of an itinerary | WF-SPARK-001 |
| Shikoku pilgrimage | Production path crashed on unexpected data shape (`.map is not a function`) | WF-SPARK-003 |
| Italy revision / Bologna + western return additions | Revision lost retained route constraints / requested additions | WF-REV-001 |
| Taiwan / Estonia / other map regressions | Unresolved/malformed stops, contradictory readiness, missing PBF geometry | WF-MAP-001 |
| Documentation regressions | Fallback/incomplete/invented text represented as successful documentation | WF-DOC-001 |
| Reload during checking | Persisted transient state could become stranded | WF-ASYNC-001, WF-PERSIST-001 |
| Windows launcher / verification scripts | Missing commands/paths and package lifecycle defects reached traveler | WF-LIFE-001, WF-REL-001 |
| Header/service health | Critical status/control area clipped or too visually weak | WF-UI-001 |

A release-system mutation suite should deliberately reproduce these failure classes and prove that the corresponding gate turns red.
