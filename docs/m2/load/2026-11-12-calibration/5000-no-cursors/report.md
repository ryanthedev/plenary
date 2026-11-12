# Load run 2026-11-12T19:44:20.531Z

**VALID** · 5000/5000 clients joined · 943/943 ops echoed · 0 closes 1013

Target ws://127.0.0.1:54383/ws board b-gn4kria2ex2p9kzb · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 426 / 1867 / 2797 / 3035 (n=289) | 1165 / 2032 / 2226 / 2480 (n=653) | – |
| echo | 403 / 1894 / 2797 / 2996 (n=290) | 1133 / 2011 / 2203 / 2456 (n=653) | – |
| delivery | 965 / 2003 / 2383 / 2996 (n=4418) | 925 / 1996 / 2385 / 2997 (n=93393) | 1070 / 2034 / 2402 / 3035 (n=4070930) |
| join (hello → welcome) | 1 / 75 / 163 / 200 (n=5000) | | |

Joins: peak 547/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 943 (e 290, a 653) | 942 | 943 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 6.5 / 58.35 | 38.5 / 75.5 |
| 1 | 834 | 0.1 / 6.3 / 64.27 | 37.4 / 68.5 |
| 2 | 833 | 0.1 / 3 / 9.17 | 39.1 / 70.8 |
| 3 | 833 | 0.1 / 8.2 / 96.22 | 39.8 / 70.1 |
| 4 | 833 | 0.1 / 4.6 / 59.65 | 39.3 / 63.8 |
| 5 | 833 | 0.1 / 4.8 / 15.09 | 39 / 63.1 |

Server (pid 77524): CPU mean 60.8% / max 85.7% of a core, RSS max 103 MB (33 ps samples).
