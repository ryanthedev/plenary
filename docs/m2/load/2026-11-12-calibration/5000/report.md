# Load run 2026-11-12T19:43:30.023Z

**VALID** · 5000/5000 clients joined · 931/931 ops echoed · 0 closes 1013

Target ws://127.0.0.1:62795/ws board b-2z3lato8w076q22g · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 2700 / 11779 / 13354 / 13667 (n=288) | 1243 / 2648 / 3325 / 3548 (n=643) | – |
| echo | 2677 / 11779 / 13354 / 13667 (n=288) | 1219 / 2624 / 3303 / 3524 (n=643) | – |
| delivery | 1146 / 9047 / 12135 / 13667 (n=4038) | 1232 / 9032 / 12224 / 13650 (n=90507) | 1471 / 9425 / 12432 / 13667 (n=3918685) |
| join (hello → welcome) | 29 / 546 / 1054 / 1063 (n=5005) | | |

Joins: peak 565/s, first to last 12 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 931 (e 288, a 643) | 931 | 931 | 0 | 0 | 0 | 7 / 0 |

Connections: 5005 opened, 5005 welcomes (5 rejoins), 5 reconnects, 5 resyncs, 0 socket errors. Closes by code: {"1000":5}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 14.3 / 75.32 | 40 / 59.2 |
| 1 | 834 | 0.1 / 8.1 / 105.95 | 41.1 / 69.2 |
| 2 | 833 | 0.1 / 13.1 / 41.68 | 40.6 / 69.4 |
| 3 | 833 | 0.1 / 7.2 / 66.64 | 40.3 / 66 |
| 4 | 833 | 0.2 / 7.8 / 31.35 | 40.5 / 59.5 |
| 5 | 833 | 0.1 / 5.1 / 16.57 | 39.7 / 67.5 |

Server (pid 74690): CPU mean 60.6% / max 80.8% of a core, RSS max 122 MB (36 ps samples).
