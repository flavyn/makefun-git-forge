# github-core-clone-01 — angka papan dan batasnya

Sumber: kit resmi `makefun/forge/kit/github-core-clone-01-kit`
(`kit.json` sha256 `8A73C5BE5FD449D7728CBB8CF91216CF3C40C255A2D3611B47574B66B8597A3B`,
bundle `e20a304d0f86d6c8e36abba6fd51a5ffdb98ec3ead8ddba20a3ed36aa09ad754`,
`RULES.txt` sha256 `3E515BC7B69CF11D02FC680DA2D0311E7C76078E3E52EBD1C1259BA40C16BE6C`).

## Rumus (program/scorer/columns.ts + score.ts)

```
score   = feature + agent + perf                       maks 1000
feature = round(600 * passed / 120)                    5 poin per check
agent   = round(200 * mcpPassed / 15)                  13,33 poin per check MCP
perf    = jumlah 4 workload, tiap workload:
          points = round(clamp(25 - 12.5*log2(p50_ms / T_ref_ms), 0, 50))
tie-break = perf_p50_us = rata-rata geometrik 4 p50 (mikrodetik), KECIL menang
```

## Denominator 120 check (state.json counts, terukur)

```
git 30 · repos 15 · issues 15 · pulls 20 · graphql 20 · mcp 15 · protocol 5
```

`agent` memakai grup `mcp` yang sama (15 check) — jadi check MCP dihitung dua kali
(5 poin di feature + 13,33 poin di agent).

## T_ref (program/env/src/calibration.json, 3 grade dev produksi)

```
push  1640.820 ms / 200 push      clone  266.941 ms / 50 clone shallow konkuren
read  2759.715 ms / 2000 GET      write  348.965 ms / 200 POST
```

Titik poin per workload:

| capai | syarat p50 | push /op | clone /op | read /op | write /op |
|---|---|---|---|---|---|
| 25 poin | = T_ref | 8,2041 ms | 5,3388 ms | 1,3799 ms | 1,7448 ms |
| 38,25 poin (≈papan top 153) | ≈0,48·T_ref | 3,94 ms | 2,56 ms | 0,662 ms | 0,837 ms |
| 50 poin (mentok) | = T_ref/4 | 2,0510 ms | 1,3347 ms | 0,3450 ms | 0,4362 ms |

## Aritmetika papan (diukur 17 Nov 00:10 WIB)

```
4389 entri · top 953 · median 919 · maksimum 1000 (feature 600 + agent 200 + perf 153)
953 = 600 + 200 + 153  ->  perf 153/200, sisa 47 poin HANYA di perf
perf 153 = rata-rata 38,25/workload = p50 ~0,48*T_ref (referensi forge sendiri cuma 100/200)
perf 200 butuh 0,25*T_ref = 4x lebih cepat dari referensi di KEEMPAT workload
```

Kesimpulan: fitur 600 + agent 200 adalah pintu masuk (median 919 sudah di situ),
tapi kursi ditentukan perf. 47 poin itu masih utuh — tidak ada di papan yang mengambilnya.

## Batas entri (competition.yaml)

```
max_file_bytes 8388608 · max_tree_bytes 16777216
cpus 2 · memory_mb 1024 · pids 256 · wall_budget_sec 900
instance final: drand round 34146612 @ 2026-11-21T06:40:00Z, instances 3, k=0 (tanpa redraw)
runtime: Node 22+ /bot/main.ts, repo read-only, tulis hanya /tmp, tanpa git binary, tanpa internet
```

## Baseline terukur (bukan asumsi)

```
grade-local --kit . --bot entries/gh-clone-01 --driver process --worktree
  score 15 = feature 15 + agent 0 + perf 0   working 1
  passed 3/120: repos.root · repos.not-found · protocol.unknown-route-json-404
  byGroup: git 0/30 graphql 0/20 issues 0/15 mcp 0/15 pulls 0/20 repos 2/15 protocol 1/5
  perf 0: keempat workload gagal di POST /api/v3/user/repos -> 404
  perf_p50_us 1000000000 (sentinel)
```

Catatan penting: prestasi keempat workload digerbangi REST `POST /api/v3/user/repos`
(owner `adaiversen`, repo `bench-push` / `bench-clone` / `bench-read` / `bench-write`).
Selama rute itu 404, perf mustahil bukan karena lambat.

## Catatan alat

`grade-local --driver process` tanpa `--worktree` GAGAL di Windows:

```
cannot copy commit bf038cb... out of entries/gh-clone-01:
fatal: '/C:/Users/xywal/AppData/Local/Temp/makefun-grade-.../bot-repo' does not appear to be a git repository
```

Path diubah ke bentuk POSIX `/C:/...`. Pakai `--worktree` (melewati ekstraksi commit).
