# History performance benchmark

Measured on 2026-11-06 with Node.js v24.21.0, Windows x64. Run `npx tsx scripts/benchmark-history.ts` from the repository root. The script compares the committed baseline (`c1f40e37e39630abfd6cf85053269b3c3e2bd40a` for these results) without the new derived indexes against the working implementation with indexes and summary responses. It deletes its temporary baseline module and databases on normal completion.

Each fixture contains 1,000 current vehicles and 10,000 or 100,000 changes. Every 2,000th change contains a DOVE report with approximately 180 KB of nested snapshot text. All changes share one timestamp. Compound search is `Actor softwareVersion v1`, deliberately matching every change; DOVE search matches the large reports. Vehicle export selects `v0` and writes a complete XLSX. These are single, unprimed application-query measurements after fixture insertion, not cold operating-system disk-cache measurements. Baseline runs before current; filesystem caching can affect comparisons.

| Changes | Operation | Baseline ms | Current ms |
| --- | --- | ---: | ---: |
| 10,000 | First page | 26 | 16 |
| 10,000 | Vehicle filter | 16 | 3 |
| 10,000 | Date filter | 34 | 21 |
| 10,000 | Compound search | 186 | 176 |
| 10,000 | DOVE search | 142 | 138 |
| 10,000 | Vehicle XLSX export | 39 | 22 |
| 100,000 | First page | 207 | 147 |
| 100,000 | Vehicle filter | 133 | 39 |
| 100,000 | Date filter | 255 | 233 |
| 100,000 | Compound search | 2,028 | 2,068 |
| 100,000 | DOVE search | 1,701 | 1,685 |
| 100,000 | Vehicle XLSX export | 168 | 125 |

For 100,000 changes, the DOVE response decreased from 9,061,368 bytes to 17,929 bytes (99.8% smaller); full snapshots remain available through lazy detail and export. First-page responses decreased from 61,538 to 18,049 bytes. The first creation of the additive indexes took 37 ms for 10,000 changes and 738 ms for 100,000 changes. Index creation runs when opening an existing local store; later openings reuse the indexes. Creating indexes increases local database size and write work.

The worst-case compound search still scans JSON values and narrowly exceeded the two-second target on this run. No substring, escaped wildcard, Chinese alias, historical VIN/model, date offset, or export semantics were relaxed to accelerate it. An earlier run concurrent with the full test suite reached 2,636 ms, illustrating sensitivity to host load. These timings are local synthetic evidence, not a performance guarantee. Actual SMB storage, team synchronization latency, and browser end-to-end timings were not measured by this script. Historical labels for deleted vehicles are covered by correctness tests; the primary timing fixture uses current vehicles.

## First-page and pagination refinement (2026-11-10)

The updated script compares the immutable **v1.7.0 / 9d1f7a6** history implementation and its published descending-created indexes against the working implementation. Both sides now use the same `summary=1` response and the same fixture, rather than comparing a full-payload/no-index baseline with summaries. The fixture retains 1,000 vehicles, 10,000/100,000 changes, identical timestamps and periodic large DOVE snapshots as described above. Measurements below were taken without a concurrent build/test run, on Windows x64 / Node.js 24.21.0. Baseline runs first; these are single application-query measurements with ordinary filesystem caching, not cold-disk or HTTP/browser timings.

| Changes | Operation | v1.7.0 ms | Current ms |
| --- | --- | ---: | ---: |
| 10,000 | First page | 14 | 2 |
| 10,000 | Page 2 | 14 | 1 |
| 10,000 | Page 100 | 35 | 1 |
| 10,000 | Vehicle filter | 4 | 4 |
| 10,000 | Date filter | 22 | 15 |
| 10,000 | Compound search | 272 | 78 |
| 10,000 | DOVE search | 126 | 129 |
| 10,000 | Vehicle XLSX export | 51 | 14 |
| 100,000 | First page | 132 | 2 |
| 100,000 | Page 2 | 135 | 1 |
| 100,000 | Page 100 | 299 | 1 |
| 100,000 | Vehicle filter | 33 | 19 |
| 100,000 | Date filter | 202 | 136 |
| 100,000 | Compound search | 1,719 | 791 |
| 100,000 | DOVE search | 1,328 | 1,317 |
| 100,000 | Vehicle XLSX export | 97 | 79 |

The published `created DESC` indexes carry implicit rowid ascending tie order, so SQLite reports `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` for `created DESC,rowid DESC`. Ascending-created indexes support a reverse scan satisfying both terms. The current plans omit that temporary sort. Unsearched list/count queries also omit the unnecessary vehicle join; keyword searches and exports retain it. Response sizes and totals were unchanged for all paired cases. Rebuilding the five benchmark indexes took 44 ms / 499 ms; existing local stores rebuild only the three legacy sort indexes once, transactionally. History rows are not rewritten by that index rebuild.

Selective DOVE substring searches still scan JSON and did not materially improve. This task prioritizes first open and pagination. No FTS tokenization, substring/Chinese alias relaxation, date/timezone change, reduced permission checking, persistent query-result cache or new dependency was introduced. Large-offset pagination remains OFFSET based. Actual team-share permission checks and browser end-to-end latency remain unmeasured.
