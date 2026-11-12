# Load run 2026-11-12T19:43:00.214Z

**VALID** · 3500/3500 clients joined · 693/693 ops echoed · 0 closes 1013

Target ws://127.0.0.1:56836/ws board b-8w6nedq2w0bsafd6 · 6 worker(s) · ramp 500/s · duration 20 s · drain 15 s

| Clients | editors | annotators | viewers | joined | never joined | connected at end |
|---|---|---|---|---|---|---|
| planned 3500 | 5 | 70 | 3425 | 3500 | 0 | 3500 |

Latency, ms: p50 / p95 / p99 / max (n)

| | editor | annotator | viewer |
|---|---|---|---|
| ack | 67 / 217 / 301 / 450 (n=275) | 80 / 254 / 312 / 356 (n=418) | – |
| echo | 59 / 202 / 285 / 450 (n=275) | 72 / 234 / 293 / 340 (n=418) | – |
| delivery | 59 / 220 / 291 / 340 (n=3178) | 58 / 219 / 291 / 450 (n=47937) | 74 / 237 / 303 / 450 (n=2169348) |
| join (hello → welcome) | 0 / 127 / 271 / 274 (n=3500) | | |

Joins: peak 500/s, first to last 8 s.

| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |
|---|---|---|---|---|---|---|---|
| | 693 (e 275, a 418) | 693 | 693 | 0 | 0 | 0 | 0 / 0 |

Connections: 3500 opened, 3500 welcomes (0 rejoins), 0 reconnects, 0 resyncs, 0 socket errors. Closes by code: {}. Errors by code: {}.

| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |
|---|---|---|---|
| 0 | 584 | 0.2 / 3.9 / 14.56 | 36.5 / 57.6 |
| 1 | 584 | 0.1 / 5.2 / 28.4 | 36.6 / 57.1 |
| 2 | 583 | 0.2 / 2.9 / 17.12 | 36.6 / 58 |
| 3 | 583 | 0.1 / 3.1 / 4.64 | 37.1 / 57.5 |
| 4 | 583 | 0.2 / 4.4 / 169.3 | 36.4 / 54 |
| 5 | 583 | 0.1 / 4.4 / 13.63 | 36.8 / 54.1 |

Server (pid 73176): CPU mean 60.3% / max 79.7% of a core, RSS max 92 MB (28 ps samples).
