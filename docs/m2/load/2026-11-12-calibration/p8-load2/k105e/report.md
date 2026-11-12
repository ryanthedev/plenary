# Load run 2026-11-12T21:07:56.104Z

**VALID** · 5000/5000 clients joined · 969/969 ops echoed · 0 closes 1013

Target ws://127.0.0.1:51374/ws board b-71b7j2787kx1jfgw · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 5000 | 5 | 100 | 4895 | 5000 | 0 | 5000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 454 / 3056 / 3843 / 3944 (n=296) | 567 / 1482 / 1760 / 2065 (n=673) | – |
| echo | 431 / 3033 / 3820 / 3919 (n=296) | 537 / 1458 / 1734 / 2038 (n=673) | – |
| delivery | 510 / 1746 / 3273 / 3923 (n=4538) | 504 / 1802 / 3316 / 3923 (n=95466) | 609 / 1908 / 3385 / 3944 (n=4148048) |
| join (hello → welcome) | 1 / 288 / 945 / 953 (n=5000) | | |

Joins: peak 524/s, first to last 12 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 969 (e 296, a 673) | 969 | 969 | 0 | 0 | 0 | 0 / 0 |

Connections: 5000 opened, 5000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 834 | 0.1 / 18.1 / 39.57 | 59.9 / 83.3 |
| 1 | 834 | 0 / 10.7 / 43.33 | 60.2 / 81.9 |
| 2 | 833 | 0.1 / 11.8 / 28.13 | 60.8 / 79.7 |
| 3 | 833 | 0.1 / 14.6 / 68.68 | 59.3 / 78.2 |
| 4 | 833 | 0.1 / 14.8 / 81.53 | 58.9 / 86.7 |
| 5 | 833 | 0.1 / 7.5 / 37.76 | 60.2 / 81.7 |

Server (pid 6975): CPU mean 78.6% / max 96% of a core, RSS max 126 MB (33 ps samples).
