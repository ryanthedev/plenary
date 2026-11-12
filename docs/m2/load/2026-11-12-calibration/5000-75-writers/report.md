# Load run 2026-11-12T19:57:03.820Z

**VALID** · 5000/5000 clients joined · 750/750 ops echoed · 0 closes 1013

Target ws://127.0.0.1:52883/ws board b-3ht0ta0ip0lt2ti8 · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 70 | 4925 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 66 / 233 / 448 / 781 (n=292) | 79 / 318 / 734 / 1281 (n=458) | – |
| echo | 59 / 224 / 408 / 761 (n=292) | 66 / 307 / 711 / 1258 (n=458) | – |
| delivery | 49 / 277 / 480 / 1258 (n=3458) | 49 / 273 / 451 / 1258 (n=52042) | 73 / 282 / 480 / 1281 (n=3265639) |
| join (hello → welcome) | 0 / 45 / 87 / 101 (n=5000) | | |

Joins: peak 502/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 750 (e 292, a 458) | 750 | 750 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 2.7 / 162.94 | 48.3 / 72.3 |
| 1 | 834 | 0 / 3 / 140.67 | 48.7 / 69.5 |
| 2 | 833 | 0 / 3.9 / 126.72 | 48.5 / 72.4 |
| 3 | 833 | 0 / 3.4 / 109.9 | 48 / 80.6 |
| 4 | 833 | 0 / 3.9 / 138.17 | 48.3 / 65.2 |
| 5 | 833 | 0 / 3 / 199.01 | 48.6 / 74.7 |

Server (pid 37784): CPU mean 76.4% / max 94.5% of a core, RSS max 108 MB (31 ps samples).
