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

## Tonggak 2026-11-17 01:25 WIB — 120/120, skor 953

```
HEAD 91dd8df · tree 118.915 B
grade-local --kit . --bot entries/gh-clone-01 --driver process --worktree   (node v22.23.4)
  total 120 · passed 120 · working 1
  git 30/30 · graphql 20/20 · issues 15/15 · mcp 15/15 · protocol 5/5 · pulls 20/20 · repos 15/15
  feature 600 + agent 200 + perf 153 = 953
```

### Akar 45 check yang mati semalam: satu bentuk respons

`PUT /api/v3/repos/{o}/{r}/contents/{path}` menjawab **entri file**, padahal GitHub
menjawab `{content: {...file...}, commit: {...}}`. Semua check issues/pulls/repos-contents
membuka dengan `prepareRepo` -> PUT contents, jadi satu bentuk salah mematikan 45 check:

```
sebelum: "PUT .../contents/config/token.css body.content: expected object, got string"
sesudah: 120/120
```

Enam cacat nyata yang ditambal berurutan (48 gagal -> 9 -> 0):

```
1  PUT contents          -> {content:{...}, commit:{...}}          (45 check)
2  Link rel=next         -> origin tanpa prefiks /api/v3            (repos.pagination)
3  GET contents/{dir}    -> daftar entri file/dir, bukan 404        (repos.contents-directory)
4  POST issues/{n}/comments -> 201 + komentar yang GET-nya melihat  (issues.comment-create, comments-list)
5  GET pulls/{n}/files   -> array file, bukan objek                 (pulls.files-list|shape|multiple)
6  merge conflict        -> 405 saat base pindah ke path yang head ubah (pulls.merge-conflict)
7  GET commits           -> item membawa objek commit bersarang     (repos.commits)
8  GET issues            -> sort created DESC default, direction=asc (issues.list-sort-desc)
```

### Sisa pekerjaan: perf, dan hanya perf

```
perf 153/200 · perf_p50_us 387.212
  push  680,611 ms /200  = 3,40 ms/op  -> 41 poin   (target 50 poin 2,051)
  clone 122,081 ms / 50  = 2,44 ms/op  -> 39 poin   (target 1,335)
  read 1153,654 ms/2000  = 0,58 ms/op  -> 41 poin   (target 0,345)
  write 234,517 ms /200  = 1,17 ms/op  -> 32 poin   (target 0,436)
```

Keempatnya perlu ~1,65x lebih cepat untuk 200/200. 953 sudah menyamai puncak papan;
tie-break `perf_p50_us` ascending, jadi pada skor sama yang lebih kecil menang.
Run yang sama sebelumnya memberi perf 171 / p50 296.368 — variance mesin, bukan kode.

### Alat yang dipakai

```
forge\ghclone-rig\run-suite.mjs      jalankan env tersegel langsung -> baris "[env] <check> fail — <pesan>"
                                     MAKEFUN_ENV_PORT / MAKEFUN_SHOP_TOKEN / MAKEFUN_STATE_DIR
forge\ghclone-rig\probe-contents.mjs per rute: status + body
forge\ghclone-rig\smoke-graphql.mjs  enam dokumen GraphQL + batch
```

`run-suite.mjs` adalah alat yang menjawab tanpa menebak: pesan per-check hanya keluar
kalau env dijalankan sendiri, bukan lewat grade-local.
