# Load run 2026-11-12T19:56:38.126Z

**VALID** · 2000/2000 clients joined · 433/433 ops echoed · 0 closes 1013

Target ws://127.0.0.1:49502/ws board b-qto5d8p9wxur2te1 · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 2000 | 5 | 40 | 1955 | 2000 | 0 | 2000 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 10 / 20 / 25 / 30 (n=233) | 10 / 22 / 30 / 35 (n=200) | – |
| echo | 9 / 18 / 25 / 30 (n=233) | 9 / 18 / 25 / 26 (n=200) | – |
| delivery | 1 / 12 / 19 / 26 (n=1932) | 1 / 12 / 19 / 26 (n=17120) | 7 / 18 / 25 / 35 (n=805765) |
| join (hello → welcome) | 0 / 1 / 4 / 19 (n=2000) | | |

Joins: peak 501/s, first to last 5 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 433 (e 233, a 200) | 433 | 433 | 0 | 0 | 0 | 0 / 0 |

Connections: 2000 opened, 2000 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 334 | 0.5 / 2.1 / 2.82 | 18.8 / 27 |
| 1 | 334 | 0.7 / 2.3 / 2.74 | 19.5 / 26.4 |
| 2 | 333 | 0.7 / 2.5 / 2.78 | 19.4 / 27.1 |
| 3 | 333 | 0.6 / 2.1 / 2.42 | 19.3 / 27 |
| 4 | 333 | 0.6 / 2.1 / 4.02 | 19.4 / 26.6 |
| 5 | 333 | 0.7 / 2.4 / 6.35 | 19.5 / 27.1 |

Server (pid 36102): CPU mean 32.4% / max 42% of a core, RSS max 78 MB (25 ps samples).
