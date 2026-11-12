# Load run 2026-11-12T21:01:29.387Z

**VALID** · 5000/5000 clients joined · 1482/1482 ops echoed · 0 closes 1013

Target ws://127.0.0.1:65475/ws board b-xngyncv1msfeb9zh · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 195 | 4800 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 4590 / 25326 / 26189 / 26378 (n=229) | 3599 / 14305 / 17963 / 21491 (n=1253) | – |
| echo | 4564 / 25325 / 26189 / 26378 (n=229) | 3574 / 13702 / 17281 / 21300 (n=1253) | – |
| delivery | 1680 / 21669 / 25325 / 26548 (n=4578) | 3377 / 19525 / 24644 / 26339 (n=276901) | 4466 / 21448 / 25219 / 27959 (n=5344867) |
| join (hello → welcome) | 65 / 9102 / 9611 / 9617 (n=5061) | | |

Joins: peak 509/s, first to last 43 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 1482 (e 229, a 1253) | 1482 | 1482 | 0 | 0 | 0 | 66 / 0 |

Connections: 6418 opened, 5061 welcomes (61 rejoins), 1418 reconnects, 189 resyncs, 1229 socket errors. Closes by code: {"1000":189,"1006":1229}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 27.2 / 891.42 | 55.5 / 117.9 |
| 1 | 834 | 0.1 / 30.4 / 497.04 | 53.9 / 82.2 |
| 2 | 833 | 0.1 / 24.5 / 717.72 | 54 / 86.1 |
| 3 | 833 | 0.1 / 19.2 / 803.29 | 53.6 / 129 |
| 4 | 833 | 0.1 / 25.9 / 595.3 | 53.9 / 88 |
| 5 | 833 | 0.1 / 35.5 / 615.29 | 53.9 / 132.1 |

Server (pid 55565): CPU mean 69.1% / max 91% of a core, RSS max 285 MB (44 ps samples).
