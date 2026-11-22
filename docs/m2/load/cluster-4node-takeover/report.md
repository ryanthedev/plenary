# Load run 2026-11-22T01:53:25.929Z

**VALID** · 200/200 clients joined · 429/429 ops echoed · 15 closes 1013

Target ws://127.0.0.1:56018/ws board b-iey0rbz5rub2u23o · 2 worker(s) · ramp 100/s · duration 35 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 200 | 5 | 10 | 185 | 200 | 0 | 200 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 5 / 2089 / 4502 / 5707 (n=355) | 5 / 8521 / 10791 / 10791 (n=74) | – |
| echo | 4 / 2089 / 4502 / 5707 (n=355) | 4 / 8521 / 10791 / 10791 (n=74) | – |
| delivery | 4 / 3336 / 8521 / 10791 (n=1709) | 4 / 2155 / 5114 / 10791 (n=3784) | 4 / 3301 / 6046 / 10791 (n=77634) |
| join (hello → welcome) | 1 / 2 / 4 / 13 (n=215) | | |

Joins: peak 100/s, first to last 2 s.

| Ops | made | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|---|
| | 429 | 429 (e 355, a 74) | 429 | 429 | 0 | 0 | 0 | 19 / 0 |

Connections: 215 opened, 215 welcomes (15 rejoins), 15 reconnects, 15 resyncs, 0 socket errors. Closes by code: {"1013":15}. Errors by code: {"unavailable":15}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 100 | 0.9 / 2.5 / 11.98 | 3.8 / 5.5 |
| 1 | 100 | 0.8 / 2.4 / 12.07 | 3.8 / 5.1 |
