# Load run 2026-11-12T21:00:50.379Z

**VALID** · 5000/5000 clients joined · 1205/1205 ops echoed · 0 closes 1013

Target ws://127.0.0.1:59166/ws board b-ey60u6d73nq5853v · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 145 | 4850 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 3957 / 19994 / 20801 / 20896 (n=246) | 2788 / 6050 / 6978 / 8169 (n=959) | – |
| echo | 3934 / 19994 / 20801 / 20896 (n=246) | 2759 / 6024 / 6937 / 8134 (n=959) | – |
| delivery | 1854 / 16328 / 20001 / 20896 (n=3953) | 2738 / 14872 / 19665 / 20876 (n=170424) | 3212 / 15512 / 19982 / 20896 (n=5072042) |
| join (hello → welcome) | 14 / 1242 / 4249 / 5626 (n=5005) | | |

Joins: peak 743/s, first to last 16 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 1205 (e 246, a 959) | 1205 | 1205 | 0 | 0 | 0 | 60 / 0 |

Connections: 5005 opened, 5005 welcomes (5 rejoins), 5 reconnects, 5 resyncs, 0 socket errors. Closes by code: {"1000":5}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 14.1 / 157.02 | 56.2 / 76.8 |
| 1 | 834 | 0.1 / 12.4 / 179.31 | 56.2 / 74.9 |
| 2 | 833 | 0.1 / 27.6 / 49.51 | 56 / 78.3 |
| 3 | 833 | 0.1 / 15.4 / 122.27 | 55.8 / 100.8 |
| 4 | 833 | 0.1 / 15.5 / 255.37 | 55.9 / 80.3 |
| 5 | 833 | 0.1 / 10.8 / 122.02 | 56.2 / 97.9 |

Server (pid 50504): CPU mean 77.1% / max 94.1% of a core, RSS max 157 MB (38 ps samples).
