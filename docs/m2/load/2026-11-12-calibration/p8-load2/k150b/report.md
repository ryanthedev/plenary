# Load run 2026-11-12T21:02:20.508Z

**VALID** · 5000/5000 clients joined · 1225/1225 ops echoed · 0 closes 1013

Target ws://127.0.0.1:56551/ws board b-s51nwf3h1ldbibnr · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 145 | 4850 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 3229 / 17702 / 18932 / 19283 (n=256) | 2341 / 5620 / 6472 / 7317 (n=969) | – |
| echo | 3194 / 17702 / 18932 / 19283 (n=256) | 2318 / 5600 / 6445 / 7292 (n=969) | – |
| delivery | 1438 / 13995 / 18018 / 19283 (n=4264) | 2277 / 12231 / 17541 / 19266 (n=172722) | 2866 / 13081 / 17689 / 19283 (n=5124805) |
| join (hello → welcome) | 4 / 1904 / 2451 / 2832 (n=5005) | | |

Joins: peak 601/s, first to last 15 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 1225 (e 256, a 969) | 1225 | 1225 | 0 | 0 | 0 | 45 / 0 |

Connections: 5005 opened, 5005 welcomes (5 rejoins), 5 reconnects, 5 resyncs, 0 socket errors. Closes by code: {"1000":5}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 15 / 88.42 | 57.2 / 80.7 |
| 1 | 834 | 0 / 11.9 / 111.28 | 57.5 / 85.2 |
| 2 | 833 | 0 / 11.1 / 82.88 | 57.7 / 78 |
| 3 | 833 | 0 / 23.3 / 78.54 | 56.8 / 83.9 |
| 4 | 833 | 0.1 / 15.6 / 59.25 | 56.4 / 82.7 |
| 5 | 833 | 0 / 12.9 / 40.75 | 57 / 81.7 |

Server (pid 61919): CPU mean 79.2% / max 93.9% of a core, RSS max 140 MB (37 ps samples).
