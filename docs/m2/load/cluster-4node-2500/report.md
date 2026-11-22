# Load run 2026-11-22T01:50:44.431Z

**VALID** · 2500/2500 clients joined · 387/387 ops echoed · 0 closes 1013

Target ws://127.0.0.1:50415/ws board b-k9mqfl58if9dwsty · 6 worker(s) · ramp 250/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 2500 | 5 | 15 | 2480 | 2500 | 0 | 2500 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 21 / 53 / 104 / 119 (n=289) | 25 / 63 / 95 / 95 (n=98) | – |
| echo | 5 / 34 / 85 / 90 (n=289) | 9 / 40 / 84 / 84 (n=98) | – |
| delivery | 6 / 39 / 77 / 92 (n=1646) | 6 / 39 / 77 / 93 (n=5707) | 18 / 52 / 88 / 122 (n=826273) |
| join (hello → welcome) | 1 / 7 / 26 / 61 (n=2500) | | |

Joins: peak 254/s, first to last 10 s.

| Ops | made | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|---|
| | 387 | 387 (e 289, a 98) | 387 | 387 | 0 | 0 | 0 | 0 / 0 |

Connections: 2500 opened, 2500 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 417 | 0.9 / 16.6 / 43.45 | 16.4 / 23.9 |
| 1 | 417 | 0.8 / 17.5 / 40.04 | 16.2 / 19.9 |
| 2 | 417 | 0.9 / 15.4 / 56.89 | 16.2 / 20.6 |
| 3 | 417 | 0.9 / 16.2 / 41.03 | 16.4 / 19.9 |
| 4 | 416 | 0.7 / 14.8 / 25.12 | 16.2 / 21.6 |
| 5 | 416 | 0.9 / 13 / 20.3 | 16.5 / 23.2 |
