# Load run 2026-11-12T21:03:31.426Z

**VALID** · 5000/5000 clients joined · 1119/1119 ops echoed · 0 closes 1013

Target ws://127.0.0.1:52215/ws board b-xscob5zdpc3g0von · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 120 | 4875 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 2466 / 8327 / 9056 / 9311 (n=299) | 1124 / 2182 / 2559 / 3107 (n=820) | – |
| echo | 2444 / 8317 / 9034 / 9288 (n=299) | 1101 / 2155 / 2537 / 3083 (n=820) | – |
| delivery | 1160 / 5744 / 8420 / 9288 (n=5285) | 1160 / 5858 / 8439 / 9288 (n=131840) | 1283 / 6166 / 8523 / 9311 (n=4790326) |
| join (hello → welcome) | 1 / 427 / 882 / 1462 (n=5000) | | |

Joins: peak 548/s, first to last 13 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 1119 (e 299, a 820) | 1119 | 1119 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 7.8 / 75.27 | 59.7 / 84 |
| 1 | 834 | 0 / 12.5 / 53 | 60.3 / 76.1 |
| 2 | 833 | 0 / 10.7 / 40.73 | 60.2 / 78.4 |
| 3 | 833 | 0 / 19.2 / 55.97 | 60.3 / 86.3 |
| 4 | 833 | 0 / 11.4 / 74.54 | 59.8 / 85.8 |
| 5 | 833 | 0 / 7.2 / 90.47 | 59.4 / 89.9 |

Server (pid 72176): CPU mean 80.8% / max 94.7% of a core, RSS max 125 MB (35 ps samples).
