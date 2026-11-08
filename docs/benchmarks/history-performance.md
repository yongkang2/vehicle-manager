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
