# Load run 2026-11-12T21:07:09.010Z

**VALID** · 5000/5000 clients joined · 1096/1097 ops echoed · 0 closes 1013

Target ws://127.0.0.1:61984/ws board b-mwfc3glvrxy8orgp · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 120 | 4875 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 1562 / 11568 / 13211 / 13911 (n=299) | 1686 / 3882 / 4688 / 11005 (n=798) | – |
| echo | 1534 / 11568 / 13211 / 13911 (n=299) | 1636 / 3853 / 4554 / 8990 (n=797) | – |
| delivery | 1254 / 6253 / 10788 / 13907 (n=4680) | 1590 / 8422 / 11682 / 17317 (n=128747) | 2029 / 9182 / 12380 / 24876 (n=4593488) |
| join (hello → welcome) | 1 / 130 / 214 / 1095 (n=5006) | | |

Joins: peak 616/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 1097 (e 299, a 798) | 1097 | 1096 | 0 | 0 | 1 | 2 / 0 |

Connections: 5006 opened, 5006 welcomes (6 rejoins), 6 reconnects, 6 resyncs, 0 socket errors. Closes by code: {"1000":6}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 30.2 / 258.33 | 40.5 / 79.5 |
| 1 | 834 | 0.1 / 31.7 / 305.53 | 40.1 / 74.6 |
| 2 | 833 | 0.1 / 31 / 161.14 | 40 / 76.2 |
| 3 | 833 | 0.1 / 33.4 / 281.04 | 40.2 / 80 |
| 4 | 833 | 0.1 / 35.5 / 139.12 | 40.5 / 76.7 |
| 5 | 833 | 0.1 / 33.7 / 233.37 | 40.3 / 75.3 |

Server (pid 1549): CPU mean 54.5% / max 95.1% of a core, RSS max 185 MB (46 ps samples).
