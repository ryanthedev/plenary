# Load run 2026-11-22T01:38:44.114Z

**VALID** · 500/500 clients joined · 299/299 ops echoed · 0 closes 1013

Target ws://127.0.0.1:65112/ws board b-wf6vlo0sx5vhrg31 · 2 worker(s) · ramp 100/s · duration 20 s · drain 10 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 500 | 5 | 10 | 485 | 500 | 0 | 500 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 9 / 19 / 26 / 37 (n=246) | 10 / 18 / 19 / 19 (n=53) | – |
| echo | 2 / 12 / 24 / 37 (n=246) | 2 / 12 / 15 / 15 (n=53) | – |
| delivery | 2 / 12 / 21 / 37 (n=1249) | 3 / 12 / 21 / 37 (n=2937) | 7 / 17 / 25 / 41 (n=133558) |
| join (hello → welcome) | 1 / 2 / 6 / 13 (n=500) | | |

Joins: peak 100/s, first to last 5 s.

| Ops | made | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|---|
| | 299 | 299 (e 246, a 53) | 299 | 299 | 0 | 0 | 0 | 0 / 0 |

Connections: 500 opened, 500 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 250 | 0.8 / 3.7 / 15.99 | 8.3 / 13.3 |
| 1 | 250 | 0.9 / 3.8 / 19.02 | 8.1 / 12.7 |
