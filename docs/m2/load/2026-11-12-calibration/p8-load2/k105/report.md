# Load run 2026-11-12T20:58:43.159Z

**VALID** · 5000/5000 clients joined · 952/952 ops echoed · 0 closes 1013

Target ws://127.0.0.1:58711/ws board b-qssxf0o8p32iv3u5 · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 215 / 894 / 1320 / 1373 (n=299) | 327 / 1038 / 1332 / 1497 (n=653) | – |
| echo | 196 / 850 / 1296 / 1373 (n=299) | 304 / 1013 / 1308 / 1475 (n=653) | – |
| delivery | 266 / 951 / 1291 / 1475 (n=4447) | 260 / 943 / 1292 / 1476 (n=94123) | 318 / 982 / 1316 / 1497 (n=4129498) |
| join (hello → welcome) | 1 / 116 / 227 / 234 (n=5000) | | |

Joins: peak 575/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 952 (e 299, a 653) | 952 | 952 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 14.7 / 33.82 | 63.3 / 91.3 |
| 1 | 834 | 0 / 7.6 / 46.1 | 65.2 / 92 |
| 2 | 833 | 0 / 6.4 / 73.35 | 65.5 / 79.2 |
| 3 | 833 | 0 / 9.5 / 288.33 | 64.7 / 79.6 |
| 4 | 833 | 0 / 18.3 / 39.55 | 64.4 / 76.8 |
| 5 | 833 | 0 / 5.9 / 57.6 | 65.6 / 89.4 |

Server (pid 39580): CPU mean 79% / max 95.1% of a core, RSS max 130 MB (32 ps samples).
