# Load run 2026-11-12T21:02:58.262Z

**VALID** · 5000/5000 clients joined · 970/970 ops echoed · 0 closes 1013

Target ws://127.0.0.1:62390/ws board b-8k9m5mwy2sldt2hi · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 330 / 836 / 1119 / 1329 (n=297) | 415 / 952 / 1238 / 1370 (n=673) | – |
| echo | 306 / 807 / 1098 / 1305 (n=297) | 390 / 929 / 1216 / 1348 (n=673) | – |
| delivery | 368 / 905 / 1145 / 1348 (n=4545) | 361 / 902 / 1145 / 1348 (n=96195) | 420 / 925 / 1164 / 1370 (n=4204580) |
| join (hello → welcome) | 1 / 106 / 147 / 158 (n=5000) | | |

Joins: peak 519/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 970 (e 297, a 673) | 970 | 970 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 8.2 / 71.1 | 63.3 / 82.9 |
| 1 | 834 | 0 / 4.9 / 42.68 | 61.3 / 81.1 |
| 2 | 833 | 0 / 8.7 / 87.11 | 64.3 / 83.7 |
| 3 | 833 | 0 / 6.3 / 93.89 | 63.2 / 78.2 |
| 4 | 833 | 0 / 6.8 / 124.76 | 63 / 87.2 |
| 5 | 833 | 0 / 8.1 / 24.3 | 63.8 / 87.2 |

Server (pid 67888): CPU mean 79.1% / max 96% of a core, RSS max 113 MB (32 ps samples).
