# Load run 2026-11-12T20:59:27.988Z

**VALID** · 5000/5000 clients joined · 944/944 ops echoed · 0 closes 1013

Target ws://127.0.0.1:64927/ws board b-5eax288nl6tr74pa · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 241 / 592 / 782 / 886 (n=289) | 302 / 718 / 862 / 1058 (n=655) | – |
| echo | 222 / 564 / 760 / 860 (n=289) | 279 / 692 / 840 / 1025 (n=655) | – |
| delivery | 256 / 654 / 836 / 1025 (n=4423) | 254 / 652 / 836 / 1025 (n=93438) | 304 / 687 / 852 / 1058 (n=4104762) |
| join (hello → welcome) | 1 / 219 / 261 / 286 (n=5000) | | |

Joins: peak 531/s, first to last 11 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 944 (e 289, a 655) | 944 | 944 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0 / 4.5 / 48.5 | 67.8 / 89.3 |
| 1 | 834 | 0 / 5.7 / 14.07 | 64.6 / 80.9 |
| 2 | 833 | 0 / 5.5 / 18.64 | 67.8 / 92.3 |
| 3 | 833 | 0 / 5.5 / 53.23 | 66.1 / 86.8 |
| 4 | 833 | 0 / 6.8 / 47.32 | 64.9 / 79.4 |
| 5 | 833 | 0 / 2.5 / 11.19 | 55.2 / 77 |

Server (pid 44742): CPU mean 79% / max 95.9% of a core, RSS max 120 MB (31 ps samples).
