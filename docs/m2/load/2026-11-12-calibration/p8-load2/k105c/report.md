# Load run 2026-11-12T21:00:00.309Z

**VALID** · 5000/5000 clients joined · 956/956 ops echoed · 0 closes 1013

Target ws://127.0.0.1:53715/ws board b-yegsqjevzjo8h7zx · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 154 / 781 / 1152 / 1192 (n=296) | 291 / 908 / 1183 / 1483 (n=660) | – |
| echo | 131 / 772 / 1130 / 1165 (n=296) | 267 / 883 / 1166 / 1445 (n=660) | – |
| delivery | 237 / 852 / 1123 / 1444 (n=4476) | 231 / 843 / 1116 / 1445 (n=94448) | 279 / 873 / 1133 / 1486 (n=4153543) |
| join (hello → welcome) | 0 / 70 / 119 / 126 (n=5000) | | |

Joins: peak 514/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 956 (e 296, a 660) | 956 | 956 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 8.5 / 58.72 | 65.2 / 84.9 |
| 1 | 834 | 0 / 5.1 / 26.06 | 66.6 / 83.2 |
| 2 | 833 | 0 / 5.7 / 36.48 | 65.9 / 83.8 |
| 3 | 833 | 0 / 4.1 / 52.28 | 63 / 82.4 |
| 4 | 833 | 0 / 5.2 / 30.24 | 64.8 / 85.1 |
| 5 | 833 | 0 / 3 / 19.91 | 66.2 / 80.9 |

Server (pid 46751): CPU mean 80.2% / max 97% of a core, RSS max 120 MB (32 ps samples).
