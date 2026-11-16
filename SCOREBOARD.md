# github-core-clone-01 — angka papan, batas, dan status terukur

Kit: `makefun/forge/kit/github-core-clone-01-kit` (`kit.json` sha256 `8A73C5BE…`,
bundle `e20a304d…`, 64 file / 23.415.957 B).
Diperbarui 2026-11-17 00:45 WIB.

## Rumus (program/scorer/columns.ts + score.ts)

```
score   = feature + agent + perf                        maks 1000
feature = round(600 * passed / 120)                     5 poin per check (selama total 120)
agent   = round(200 * mcpPassed / 15)                   13,33 poin per check MCP
perf    = jumlah 4 workload, tiap workload:
          points = round(clamp(25 - 12.5*log2(p50_ms / T_ref_ms), 0, 50))
tie-break = perf_p50_us = rata-rata geometrik 4 p50 (us), KECIL menang
```

Denominator 120: `git 30 · repos 15 · issues 15 · pulls 20 · graphql 20 · mcp 15 · protocol 5`.
Grup `mcp` (15 check) dinilai dua kali: 75 poin di feature + 200 di agent.

## T_ref (program/env/src/calibration.json)

```
push  1640.820 ms / 200 push      clone  266.941 ms / 50 clone shallow konkuren
read  2759.715 ms / 2000 GET      write  348.965 ms / 200 POST
```

| capai | syarat p50 | push /op | clone /op | read /op | write /op |
|---|---|---|---|---|---|
| 25 poin | = T_ref | 8,2041 ms | 5,3388 ms | 1,3799 ms | 1,7448 ms |
| 38,25 poin (setara papan 153) | ≈0,48·T_ref | 3,94 ms | 2,56 ms | 0,662 ms | 0,837 ms |
| 50 poin (mentok) | = T_ref/4 | 2,0510 ms | 1,3347 ms | 0,3450 ms | 0,4362 ms |

## Aritmetika papan (17 Nov 00:10 WIB)

```
4389 entri · top 953 · median 919 · maksimum 1000
953 = 600 + 200 + 153  ->  sisa 47 poin HANYA di perf
perf 200 butuh 0,25*T_ref = 4x lebih cepat dari forge referensi di KEEMPAT workload
```

## Status terukur 2026-11-17 00:40 WIB

```
HEAD d2e3fcf · committed tree 60.313 B · TAPI tree KOTOR:
  M main.ts · M src/store.mjs · ?? src/git.mjs (25.897 B, belum di-commit)
grade-local --worktree: passed 23/120 · working 1
  mcp 15/15 · repos 5/15 · protocol 2/5 · git 1/30 · issues 0/15 · pulls 0/20 · graphql 0/20
  feature round(600*23/120) = 115 · agent round(200*15/15) = 200  -> 315
```

`275` = kontribusi mcp saja (75 feature + 200 agent). Total entri 315.

Lulus: `repos.create|foreign-token|meta|not-found|root`, `protocol.malformed-body-400`,
`protocol.unknown-route-json-404`, `git.clone-empty`, dan 15/15 mcp.

## Blocker git (30 check + 2 workload)

```
push:   Error: push refs/heads/main: unpack failed (invalid stored block lengths)
clone:  Error: push refs/heads/main: unpack failed (invalid stored block lengths)
```

Kegagalan di ingest pack (`src/git.mjs` readPack/inflate), bukan di advertise.
`git.clone-empty` lulus — advertise + clone kosong jalan, push tidak.

## Perf tidak bisa diukur di mesin ini (bukan soal kode entri)

Harness mengukur lewat `fetch` (`rest-client.ts:416`). Di win32, `fetch` + keep-alive
membayar ~13,9 ms per request, **apa pun bentuk responsnya**:

```
node:http keep-alive            0,1967 ms/op        (server + payload sama)
undici fetch keep-alive        13,6085 - 13,8945    json / text / arrayBuffer / json ulang
undici fetch Connection: close  2,3110              (6x lebih cepat dari keep-alive)
```

Bentuk respons diuji (500 op, proses terpisah), tidak berpengaruh:

```
body 50 B  13,8945 · body 0 B  14,0080 · body 4.096 B  13,9983 · split 10+39 B  13,9869 ms/op
```

Handler entri sendiri, diukur dengan `node:http` (2000 GET keep-alive):

```
round 461,1 / 440,8 / 415,9 ms  ->  p50 440,8 ms = 0,2204 ms/op
```

Jadi 27,7 s yang harness catat untuk `read` = 2000 x 13,9 ms di klien, bukan di entri.
T_ref 1,38 ms/op hanya masuk akal kalau undici di Linux normal; T_ref diukur di klaster
produksi. **Kolom perf `--driver process` di mesin ini selalu ~0 untuk read/write, entri
apa pun.** Docker tidak ada, WSL tanpa distro: tidak ada jalur Linux lokal.

Konsekuensi desain: handler read 0,2204 ms/op sudah 6x di bawah anggaran 50 poin
(0,345 ms/op) bila diukur tanpa artefak klien. Anggaran itu dipertahankan; angka lokal
dipakai hanya sebagai perbandingan antar-versi entri, tidak sebagai prediksi poin.

## Rig

```
forge\ghclone-rig\measure-read.mjs   2000 GET keep-alive ke entri (klien node:http, jujur)
forge\ghclone-rig\client-gap.mjs     node:http vs undici fetch, server minimal
forge\ghclone-rig\fetch-iso.mjs      satu varian per proses (json/text/arrayBuffer/close)
forge\ghclone-rig\fetch-shape.mjs    bentuk respons: small/empty/big/two-write
```

## Catatan alat

`grade-local --driver process` tanpa `--worktree` gagal di Windows (path jadi `/C:/Users/...`
-> `does not appear to be a git repository`). Selalu pakai `--worktree`.
