# Twinnear — QA / Audit Findings (Agen 2)

Tanggal: 2026-11-06 ~23:30 WIB · Auditor: Agen 2 (QA + Pantau)
Ruang lingkup: `contract/src/lib.rs`, `frontend/src/**`, `relayer-server/server.mjs`,
`README.md`, `DEPLOY.md`. Audit READ-ONLY — tidak ada file source yang diubah.
Satu-satunya file yang ditulis adalah dokumen ini.

## Verifikasi yang dijalankan (bukti klaim fase 1–2)

| Klaim | Hasil verifikasi |
|---|---|
| Kontrak 12 unit test lolos | ✅ TERKONFIRMASI — `cargo test` (PATH `~/.cargo/bin`): `12 passed; 0 failed` |
| Wasm 326.146 byte, SHA-256 `3cb04b1a…` | ✅ TERKONFIRMASI — `ls` 326146 byte; `sha256sum` = `3cb04b1afa20e5fea98588bb79da34f55b936ad6998a5b1af03940003f58972a` |
| Frontend build sukses | ✅ TERKONFIRMASI — `npm run build` sukses (tsc + vite, 13,97 dtk). Peringatan: chunk JS 1.347,95 kB (gzip 406 kB) > 500 kB; ada warning `buffer`/`util`/`http`/`https`/`crypto` di-externalize dari dependensi wallet-selector (lihat L-02) |
| 1Click live, tanpa testnet | ✅ TIDAK DIBANTAH dari kode — `frontend/src/lib/intents.ts:94` menolak `.testnet` dengan pesan jelas; klaim probe curl 6 Nov tidak diuji ulang (tidak ada dana yang digerakkan) |
| Relayer Borsh byte-identical | ⚠️ TIDAK DAPAT DIVERIFIKASI dari repo — tidak ada script/bukti test perbandingan serializer di repo; hanya komentar di `server.mjs`. Tetap butuh click-through Meteor (diakui di README) |
| Kontrak BELUM di-deploy | ✅ TERKONFIRMASI LANGSUNG VIA RPC — `view_account twinnear.testnet`: balance persis 4 NEAR, `code_hash: 1111…` (nol), `storage_usage: 182`; `view_code` → `NO_CONTRACT_CODE` |
| Akun twinnear.testnet 4 NEAR | ✅ TERKONFIRMASI — `amount: 4000000000000000000000000` yocto, `locked: 0` |

## Kesimpulan singkat

**TIDAK ADA TEMUAN CRITICAL.** Inti escrow sehat: tidak ada jalur pencurian dana
langsung, tidak ada double-spend, tidak ada replay meta-tx, dan kontrol akses
owner/relayer/seller/client ditegakkan di semua fungsi yang diperiksa.
Yang ada adalah **7 temuan High** — satu di antaranya (H-01) memblokir jalur
deploy via browser dalam kondisi live saat ini, dan dua di antaranya (H-02, H-03)
dapat mengunci dana escrow pengguna secara permanen bila kondisi pemicunya terjadi.
Sisanya adalah celah griefing/ekonomi (relayer terbuka, spam invoice gratis),
lubang desain (tanpa timeout escrow, tanpa verifikasi tanda tangan on-chain),
dan jebakan silent-failure di frontend. Semua High harus diperbaiki sebelum
atau segera setelah deploy; tidak ada yang membutuhkan redesign total.

Pemilik perbaikan: **Agen 1** = soal desain/ide/keputusan produk;
**Agen 3** = soal kode/implementasi.

---

## HIGH

### H-01 — `isContractDeployed()` salah deteksi: akun yang sudah ada tapi belum ada kode dianggap "Deployed", halaman Deploy menyembunyikan form deploy
- **File:** `frontend/src/lib/near.ts:76-88` (`request_type: "view_account"`), dipakai `frontend/src/App.tsx:19-29` dan `frontend/src/pages/Deploy.tsx:36-44,196-214`
- **Bukti (live):** RPC `view_account twinnear.testnet` saat ini SUKSES (akun ada, saldo 4 NEAR, `code_hash: 1111…`), sementara `view_code` mengembalikan `NO_CONTRACT_CODE`. Jadi `isContractDeployed()` mengembalikan `true` SEKARANG, sebelum deploy. Alurnya: `Deploy.check()` → `setDeployed(true)` → `getOwner()` gagal (tidak ada kode) → `catch` hanya set error, `deployed` tetap `true` → halaman Deploy masuk cabang `deployed === true` ("The contract is live") dan form pilih wasm + tombol "Deploy + initialize" TIDAK PERNAH tampil. Banner App juga salah ("Contract not deployed yet" hilang). Jalur browser yang disebut "recommended" di `DEPLOY.md` praktis tidak bisa dipakai sampai bug ini diperbaiki — hanya Path B (CLI) yang tersisa.
- **Perbaikan:** ganti deteksi menjadi `view_code` (atau coba `get_owner()` dan anggap gagal = belum deploy): `code_hash !== "1111…"` / `view_code` sukses ⇒ deployed. Di `Deploy.check()`, jangan `setDeployed(true)` sebelum `getOwner()` berhasil; bila `getOwner()` gagal, set `deployed=false`.
- **Pemilik:** Agen 3 (kode).

### H-02 — `release_invoice` / `refund_invoice`: state diubah dulu, transfer `.detach()` tanpa callback — bila transfer gagal, dana terkunci selamanya tanpa jalur pemulihan
- **File:** `contract/src/lib.rs:269-290` (release) dan `:292-311` (refund); tidak ada fungsi withdraw/rescue/cancel di seluruh file.
- **Bukti:** `release_invoice` set `released=true` + `insert` (L283-284) lalu `Promise::new(seller).transfer(...).detach()` (L285-287). `refund_invoice` set `status=Refunded` (L306) lalu transfer `.detach()` (L308-310). Tidak ada callback `then`, tidak ada pengecekan hasil promise, tidak ada fungsi retry. Bila transfer gagal (akun penerima dihapus, saldo kontrak di bawah minimum storage karena pembuatan invoice mengunci storage — lihat H-06, atau saldo escrow tergerus), invoice sudah tercatat selesai dan dana tidak bisa diambil lagi oleh siapa pun: tidak ada `withdraw`, tidak ada owner-rescue, tidak ada retry. Double-spend-nya sendiri AMAN (cek `status==Paid` + `!released` sebelum mutasi), tapi kegagalan satu arah ini bersifat permanen.
- **Perbaikan:** (a) pakai pola callback: transfer dengan `.then(ext_self::on_release_callback)` yang hanya menandai `released=true` bila transfer sukses, dan mengembalikan status bila gagal; atau (b) minimal tambahkan `claim_stuck_escrow(id)` / owner-rescue dengan timelock + event. Uji dengan skenario transfer-ke-akun-yang-dihapus.
- **Pemilik:** Agen 3 (kode); bila diputuskan tidak ada rescue sama sekali, itu keputusan desain → Agen 1.

### H-03 — Escrow tanpa batas waktu / tanpa sengketa: bila seller diam, dana client terkunci selamanya; client tidak punya jalan keluar apa pun
- **File:** `contract/src/lib.rs:244-311` (`pay_invoice`, `release_invoice`, `refund_invoice`) — desain; tidak ada `deadline`, `dispute`, `cancel`, atau `timeout` di `Invoice` (L39-52) maupun di fungsi mana pun.
- **Bukti:** Setelah `pay_invoice`, hanya seller yang bisa `release`/`refund`, keduanya tanpa batas waktu. Client tidak bisa meminta refund sendiri, tidak bisa membuka sengketa, tidak ada kedaluwarsa. Invoice `Pending` juga tidak bisa dibatalkan seller (tidak ada `cancel_invoice` — salah ketik jumlah/klien = invoice sampah permanen yang hanya bisa "diselesaikan" dengan membayar lalu memohon refund). Untuk track "Real-World Money" dan demo di depan juri, ini pertanyaan pertama yang akan muncul: "apa yang terjadi bila freelancer menghilang?"
- **Perbaikan (desain):** tambah `deadline` opsional saat `create_invoice` (mis. 7/14 hari); setelah deadline, client boleh `claim_refund` sendiri bila belum release. Tambah `cancel_invoice` untuk seller selama `Pending`. Ini perubahan desain + skema — putuskan sebelum deploy karena mengubah struct `Invoice`.
- **Pemilik:** Agen 1 (desain/keputusan), implementasi Agen 3.

### H-04 — Relayer terbuka tanpa auth/rate-limit: siapa pun bisa menguras NEAR relayer dengan membanjiri invoice gasless atas nama diri sendiri
- **File:** `relayer-server/server.mjs:267-282` (server tanpa auth apa pun; `Access-Control-Allow-Origin: *` L269), `:155-265` (`handleRelay` tanpa rate limit/kuota/cap), `:123-144` (akun relayer dari env, tanpa cek saldo).
- **Bukti:** Satu-satunya syarat untuk memakai relayer adalah tanda tangan NEP-413 yang valid — dan penyerang MEMILIKI kunci akunnya sendiri, jadi ia bisa menandatangani invoice untuk dirinya sendiri tanpa batas, masing-masing membebani relayer gas `create_invoice_meta` (±100 Tgas). Tidak ada API key, allowlist seller, batas per akun/per jam, atau batas jumlah invoice. Tidak ada cek saldo relayer sebelum submit, tidak ada alerting. CORS `*` berarti situs web mana pun bisa memanggilnya dari browser. Satu malam spam = relayer kering, jalur gasless mati untuk semua orang, dan tidak ada yang tahu sampai pengguna mengeluh.
- **Perbaikan:** tambah allowlist seller (env `RELAYER_ALLOWED_SELLERS`) atau API key sederhana, rate-limit per seller (mis. 10/jam) + cap jumlah invoice, cek saldo relayer di `/health`, dan log setiap relay. Untuk demo hackathon, allowlist saja sudah cukup.
- **Pemilik:** Agen 3 (kode); kebijakan allowlist vs terbuka → Agen 1.

### H-05 — Jalur deploy CLI (Path B) punya jendela front-running `init`: deploy tanpa init lalu init terpisah — siapa pun bisa merebut `owner`
- **File:** `contract/src/lib.rs:90-99` (`new(owner)` — `#[init]`, pemenang pertama mengambil alih; tidak ada pengecekan siapa yang boleh init), `DEPLOY.md:86-101` (langkah `deploy … without-init-call` lalu `call-function … new` sebagai dua transaksi terpisah).
- **Bukti:** `new()` menerima `owner` apa pun dari pemanggil pertama dan tidak ada cara mengganti owner sesudahnya (tidak ada `set_owner`). Bila seseorang memantau mempool/testnet di antara kedua perintah Path B, ia bisa memanggil `new` dengan `owner` dirinya sendiri; setelah itu ia mengendalikan `set_relayer` (L202-211) selamanya. Path A (browser, DeployContract + `new` dalam SATU transaksi) aman dari ini — tapi Path A sedang diblokir H-01, sehingga Path B yang berisiko inilah satu-satunya jalan yang berfungsi saat ini.
- **Perbaikan:** jadikan Path A sebagai satu-satunya jalur yang didokumentasikan sampai H-01 diperbaiki; bila Path B tetap dipakai, deploy + init harus dalam satu blok (gunakan `near contract deploy … with-init-call` bila didukung) dan segera verifikasi `get_owner`. Jangka panjang: tambah `set_owner` (owner lama → owner baru, dua langkah) atau kunci init ke `twinnear.testnet`.
- **Pemilik:** Agen 3 (kode + DEPLOY.md); keputusan jalur deploy → Agen 1.

### H-06 — Pembuatan invoice gratis membebani storage kontrak: spam invoice dapat mengunci saldo kontrak sampai transfer escrow gagal
- **File:** `contract/src/lib.rs:102-146` (`create_invoice_inner` — tidak ada `attached_deposit`, tidak ada biaya, tidak ada batas per seller), `:269-311` (release/refund mentransfer dari saldo kontrak yang sama).
- **Bukti:** Setiap invoice baru menambah `storage_usage` kontrak (±200–300 byte ≈ 0,002–0,003 NEAR yang terkunci dari saldo kontrak). Pembuatan tidak memungut deposit storage dari seller, tidak ada batas jumlah invoice per akun. Penyerang (atau demo yang antusias) bisa membuat ribuan invoice dan mengunci saldo kontrak; karena dana escrow dan cadangan storage berasal dari SATU saldo akun yang sama, `available_balance` bisa jatuh di bawah total escrow → `release`/`refund` gagal → bergabung dengan H-02 (dana terkunci). `list_invoices` sendiri aman dari sisi ini (`limit` dijepit `saturating_add`, L331-347).
- **Perbaikan:** minta `attached_deposit` kecil saat `create_invoice` (mis. 0,01 NEAR) untuk menutup storage, atau batasi invoice per seller, atau lacak `total_escrowed` dan tolak pembuatan bila `saldo tersedia − escrow < cadangan`. Minimal: catat di README bahwa pembuatan invoice bukan gratis bagi kontrak.
- **Pemilik:** Agen 1 (desain ekonomi) + Agen 3 (implementasi).

### H-07 — `set_policy`: input tidak valid diam-diam menjadi "tanpa batas" — kebalikan dari yang dimaksud pengguna
- **File:** `frontend/src/lib/near.ts:214-226` (`parseNearAmount(maxAmountNear) ?? "0"`), `frontend/src/pages/Policy.tsx:72-78` (validasi hanya `Number(value)` — lolos untuk `"1e3"`, `"0.0000000000000000000000000001"`, `"1.2.3"`? — lihat bawah).
- **Bukti:** `parseNearAmount` mengembalikan `null` untuk format yang tidak bisa diparse (notasi eksponen, desimal >24 digit, dsb.). Fallback `?? "0"` mengubahnya menjadi `max_amount = 0`, yang di kontrak (`lib.rs:117-122`) berarti **TIDAK ADA BATAS** — persis kebalikan dari pengguna yang mengetik batas protektif. `Policy.tsx` memvalidasi dengan `Number(value)`, yang menerima `"1e3"` (1000) — `parseNearAmount("1e3")` mengembalikan `null` → batas 1000 NEAR yang dimaksud pengguna tersimpan sebagai "tanpa batas". Tidak ada error yang ditampilkan. Ini silent-failure pada fitur keamanan utama (spend-guard).
- **Perbaikan:** di `near.ts:setPolicy`, `throw new Error("Invalid amount")` bila `parseNearAmount` mengembalikan `null` (jangan fallback `"0"`); samakan validasi `Policy.tsx` dengan regex desimal murni (`/^\d+(\.\d{1,24})?$/`). Uji: `"1e3"`, `"0.0000000000000000000000000001"`, `"abc"`.
- **Pemilik:** Agen 3 (kode).

---

## MEDIUM

### M-01 — Tanda tangan meta-tx TIDAK PERNAH diverifikasi on-chain: relayer yang dikompromikan bisa membuat invoice atas nama seller mana pun
- **File:** `contract/src/lib.rs:171-200` (`create_invoice_meta` hanya memeriksa `predecessor == relayer` + `nonce > last`; `signature`/`public_key` hanya di-`log`, L189-193, tidak diverifikasi), `relayer-server/server.mjs:214-227` (verifikasi hanya off-chain).
- **Bukti:** Seluruh keamanan meta-tx bergantung pada server relayer yang tidak diaudit dan kuncinya. Relayer jahat/teretas bisa memanggil `create_invoice_meta` dengan `seller` siapa pun, `client`/`amount`/`description` apa pun — tanpa tanda tangan seller sama sekali — dan kontrak menerimanya selama nonce naik. Nonce pun hanya `>` bukan `== last+1`, jadi nonce bisa dilompati. Spend-guard client tetap ditegakkan (`create_invoice_inner`), tapi seller tidak punya pertahanan apa pun terhadap invoice yang dibuat atas namanya. Test yang ada (`meta_flow_and_nonce_replay`, L~495) memakai `signature: "sig"` palsu dan lolos — membuktikan kontrak memang tidak memeriksa tanda tangan.
- **Perbaikan:** verifikasi ed25519 on-chain atas payload yang sama (atau minimal: relayer menandatangani ulang / kontrak memeriksa `env::ed25519_verify`). Bila terlalu mahal untuk hackathon, dokumentasikan secara eksplisit sebagai asumsi trust ("relayer tepercaya penuh") di README + halaman New Invoice, dan buat rotasi relayer mudah (sudah ada `set_relayer`). Alternatif murah: seller harus lebih dulu menyetujui relayer via `approve_relayer`.
- **Pemilik:** Agen 1 (keputusan model trust) + Agen 3 (implementasi bila dipilih verifikasi on-chain).

### M-02 — `confirm_external_payment` adalah klaim sepihak tanpa verifikasi apa pun; ledger menghitungnya sebagai "Received"
- **File:** `contract/src/lib.rs:217-241` (hanya cek `caller == seller` + `status == Pending`; `reference` string bebas, boleh kosong; set `Paid` + `released=true`, L234), `frontend/src/pages/Dashboard.tsx:36-40` (`Received` = `Paid && released`, termasuk external), `frontend/src/pages/PayInvoice.tsx:353-372` (kolom `extRef` kosong, tidak di-prefill dari deposit address).
- **Bukti:** Seller bisa menutup invoice sebagai "Paid · released" tanpa pembayaran apa pun — tidak ada cek deposit address, jumlah, atau status 1Click. Dashboard lalu menghitungnya sebagai uang diterima, dan CSV mengekspornya tanpa kolom `external_ref` (lihat L-06). Sebaliknya, alur yang benar pun rapuh: setelah 1Click `SUCCESS`, UI hanya menampilkan teks "ask the seller to confirm it below" — seller harus menyalin-tempel deposit address secara manual ke kolom kosong.
- **Perbaikan:** (a) prefill `extRef` dari `quote.depositAddress` bila ada; (b) validasi `reference` tidak kosong dan format `0x…` 42 karakter; (c) bedakan status tampilan "Paid · external (unverified)" dari "Paid · released" di Dashboard/CSV, atau tambah kolom `settlement_type` (`escrow` vs `external`) di kontrak; (d) ideal: relayer/oracle memverifikasi status 1Click sebelum `confirm` (di luar skop hackathon — catat sebagai known limitation).
- **Pemilik:** Agen 1 (desain: apakah klaim sepihak dapat diterima + pelabelan) + Agen 3 (prefill/validasi/label).

### M-03 — Spend-guard hanya ditegakkan saat invoice dibuat, bukan saat dibayar; tidak ada batas total/kumulatif
- **File:** `contract/src/lib.rs:115-129` (cek policy hanya di `create_invoice_inner`), `:244-267` (`pay_invoice` tidak mengecek ulang policy), `:217-241` (`confirm_external_payment` tidak mengecek policy sama sekali).
- **Bukti:** (1) Invoice yang dibuat SEBELUM client memasang policy tetap bisa dibayar penuh — policy tidak berlaku surut dan `pay_invoice` tidak memeriksa ulang. (2) Policy hanya membatasi PER invoice: seller bisa membuat 100 invoice @ batas maksimum dan client membayar semuanya — tidak ada cap harian/total. (3) Jalur 1Click/external sepenuhnya melewati spend-guard (tidak ada escrow, tidak ada cek). Pengguna yang mengira "saya sudah memasang spend-guard jadi saya aman" keliru pada ketiga jalur ini.
- **Perbaikan:** cek ulang policy di `pay_invoice` (tolak bayar bila invoice melanggar policy SAAT INI), tambah cap kumulatif opsional (`max_total_per_day`), dan tampilkan peringatan di halaman Policy bahwa policy tidak berlaku surut dan tidak mencakup pembayaran external. Keputusan skop → Agen 1.
- **Pemilik:** Agen 1 (desain) + Agen 3 (implementasi).

### M-04 — Relayer: race nonce ganda + tidak ada idempotency; satu invoice bisa dilaporkan gagal padahal berhasil dibuat
- **File:** `relayer-server/server.mjs:199-232` (cek `counter <= lastNonce` lalu submit, tanpa lock/antrian per seller), `:236-261` (bila tx gagal, kembalikan 400 tanpa memeriksa apakah invoice sebenarnya sudah dibuat).
- **Bukti:** Dua POST bersamaan dengan `counter` sama (mis. pengguna klik dua kali / retry) keduanya lolos cek off-chain (keduanya membaca `lastNonce` yang sama sebelum salah satu mendarat). Satu tx sukses, satu gagal di kontrak; yang gagal dikembalikan sebagai 400 generik, frontend menampilkan error — padahal invoice SUDAH ADA. Tidak ada kunci idempotency, tidak ada antrean per-seller, tidak ada lookup `list_invoices` pasca-gagal. Juga: bila `getRelayerAccount()` gagal sekali (kunci salah / RPC mati), `nearPromise` yang rejected dipakai selamanya (L123-144) — server harus di-restart untuk pulih.
- **Perbaikan:** serialisasi per-seller (mutex/antrean sederhana berdasarkan `seller`), reset `nearPromise = null` bila `connect()` gagal, dan saat tx gagal, cek apakah invoice dengan nonce itu sudah ada sebelum mengembalikan error.
- **Pemilik:** Agen 3 (kode).

### M-05 — Frontend tidak memeriksa saldo / jaringan sebelum mengirim transaksi; error mentah dari wallet ditampilkan apa adanya
- **File:** `frontend/src/pages/Deploy.tsx:84-125` (tidak ada cek saldo vs `fileSize/100_000` NEAR yang justru sudah dihitung dan ditampilkan), `frontend/src/lib/near.ts:139-158` (`deployContract` tanpa deposit/gas eksplisit untuk DeployContract), `frontend/src/pages/NewInvoice.tsx:18-55` + `Policy.tsx:56-97` (tidak ada cek akun berakhiran `.testnet` vs network; `.near` mainnet lolos validasi suffix), `frontend/src/pages/PayInvoice.tsx:62-75` (`run()` menampilkan `err.message` mentah).
- **Bukti:** (1) Deploy: halaman sudah menghitung "≈3,26 NEAR locked" tapi `handleDeploy` tidak pernah membandingkan dengan saldo akun — bila saldo kurang, transaksi gagal di wallet dengan pesan generik dan gas terbuang. (2) Tidak ada penjaga "jaringan salah": akun mainnet `.near` lolos validasi `NewInvoice`/`Policy` (hanya cek suffix `.testnet`/`.near`) lalu transaksi testnet gagal secara membingungkan. (3) Semua halaman menampilkan `err.message` mentah dari wallet/RPC (sering berupa JSON/teks teknis) tanpa terjemahan ke bahasa pengguna. (4) `deployContract` tidak memeriksa hash wasm terhadap hash yang diharapkan (`3cb04b…`) — file wasm salah/korup/bukan Twinnear bisa ter-deploy tanpa peringatan (hanya cek ekstensi `.wasm`, `Deploy.tsx:66-70`).
- **Perbaikan:** cek saldo via `view_account` sebelum Deploy/Pay dan tampilkan "saldo kurang, butuh X NEAR"; tolak akun yang tidak berakhiran `.testnet` saat `NETWORK_ID=testnet` (dengan pesan jelas); bandingkan SHA-256 file dengan hash build yang diharapkan dan beri peringatan bila beda; petakan error umum (insufficient balance, wrong network, user rejected) ke pesan yang ramah.
- **Pemilik:** Agen 3 (kode).

### M-06 — Setelah submit, halaman langsung `load()` ulang sebelum finalitas: status yang ditampilkan basi, pesan "confirm lalu refresh" bertentangan dengan reload otomatis
- **File:** `frontend/src/pages/PayInvoice.tsx:62-75` (`setDone("…confirm it in your wallet, then refresh.")` lalu `await load()` segera), `frontend/src/pages/Policy.tsx:80-85` (pola sama), `frontend/src/pages/Deploy.tsx:100-113` (`await check()` segera setelah submit).
- **Bukti:** `load()` memakai `finality: "final"` tetapi dipanggil sepersekian detik setelah wallet mengembalikan — transaksi belum final, sehingga status/policy/owner yang dibaca masih lama. Pengguna melihat "Payment submitted" BERSAMAAN dengan status yang belum berubah, lalu mengira transaksi gagal dan bisa mengulanginya (bayar dua kali = invoice kedua? — tidak, `pay_invoice` menolak invoice yang sudah Paid, jadi risikonya kebingungan + klik ganda, bukan double-spend). Di Deploy, `check()` yang terlalu dini dapat menampilkan error `getOwner()` yang menakutkan padahal deploy sedang berjalan.
- **Perbaikan:** jangan `load()` otomatis setelah submit; tampilkan tx hash + tautan explorer dan tombol "Refresh status" (atau polling dengan jeda 3–5 dtk sampai status berubah / timeout 60 dtk). Tampilkan tx hash untuk pay/release/refund (saat ini tidak ada — hanya Deploy yang menampilkannya).
- **Pemilik:** Agen 3 (kode).

### M-07 — Bila relayer mati, jalur gasless gagal tanpa fallback; tidak ada timeout di mana pun
- **File:** `frontend/src/lib/relayer.ts:141-207` (`submitMetaTransaction` — `fetch` tanpa timeout; bila relayer mati/unreachable, throw dan `NewInvoice` hanya menampilkan error), `relayer-server/server.mjs:70-88` (`rpcQuery` — `fetch` tanpa timeout/abort), `:155-156` (baca body tanpa batas ukuran).
- **Bukti:** Tidak ada fallback otomatis ke direct `create_invoice` (pengguna harus manual menghilangkan centang gasless dan mengulang — dan checkbox gasless bahkan tidak muncul bila `VITE_RELAYER_URL` tidak diset, `NewInvoice.tsx:105-124`). Tidak ada timeout pada `fetch` relayer maupun RPC server (request bisa menggantung tanpa batas), tidak ada retry. Server juga tidak membatasi ukuran body (`for await (chunk of req)` tanpa batas — satu POST raksasa dapat memenuhi memori). Bila server mati, tidak ada `/health` yang dipantau siapa pun dan tidak ada pesan "relayer sedang mati, pakai jalur langsung".
- **Perbaikan:** tambah `AbortSignal.timeout(15_000)` di semua `fetch`, tawarkan tombol "coba lagi via transaksi langsung" saat relayer gagal, batasi body (mis. 64 KB), dan dokumentasikan bahwa relayer adalah single point of failure untuk jalur gasless saja (jalur langsung tetap jalan).
- **Pemilik:** Agen 3 (kode).

### M-08 — Risiko ekonomi deploy: wasm 326 KB mengunci ~3,26 NEAR; sisa liquid hanya ~0,5–0,7 NEAR — margin terlalu tipis untuk demo
- **File:** `DEPLOY.md:38-41`, `README.md:75-78`, `frontend/src/pages/Deploy.tsx:22-24` (peringatan sudah ada — bagus), `contract/Cargo.toml` (profil release sudah `opt-level="z"`, `lto=true`, `panic="abort"`).
- **Bukti (angka):** Akun `twinnear.testnet` terverifikasi via RPC: saldo 4,0 NEAR persis, `locked: 0`. Biaya storage kode: 326.146 byte × 1 NEAR/100 KB ≈ **3,26 NEAR** terkunci. Sisa: 4 − 3,26 = **~0,74 NEAR**, dikurangi cadangan minimum akun 0,2 NEAR dan gas deploy → **liquid efektif ~0,5 NEAR**. Setiap invoice baru mengunci ±0,002–0,003 NEAR lagi (H-06). Demo invoice 0,05–0,1 NEAR masih muat, tapi: satu deploy ulang (mis. perbaikan H-02/H-03 mengubah wasm) tidak menambah biaya storage kode secara penuh (replace code: selisih ukuran saja), namun bila deploy GAGAL di tengah karena saldo kurang, tidak ada sisa untuk retry + faucet butuh waktu. Faucet testnet memberi ±2 NEAR per permintaan (dari pengalaman proyek ini), jadi top-up bukan instan. Tingkat keparahan: **HIGH** (bukan Critical — deploy pertama hampir pasti berhasil, tapi tidak ada ruang untuk kesalahan, dan satu demo yang boros dapat membuat akun tidak bisa membayar gas/release).
- **Mitigasi (urut prioritas):**
  1. **Top-up dulu sebelum deploy** — minta 2 NEAR lagi dari faucet (https://near-faucet.io) sehingga saldo ≥6 NEAR; paling murah dan paling aman. (Agen 1: minta pengguna melakukannya; Agen 3: verifikasi saldo via RPC sebelum deploy.)
  2. **Perkecil wasm** — jalankan `wasm-opt -Oz` / `wasm-strip` pada hasil build; hapus dependensi/format yang tidak perlu. Target <250 KB (≈2,5 NEAR). Catatan: profil release sudah `opt-level="z"`+LTO, jadi sisa penghematan kemungkinan hanya 5–15% tanpa memangkas fitur. (Agen 3.)
  3. **Jangan deploy ke sub-akun untuk menghemat storage** — itu tidak menghemat: biaya storage dihitung per byte kode di akun mana pun. Sub-akun hanya berguna untuk isolasi, bukan penghematan.
  4. **Jaga anggaran demo** — invoice demo 0,05 NEAR, maksimal belasan invoice, dan jangan buat invoice spam sebelum demo. (Agen 1: jalankan demo sesuai anggaran.)
  5. Bila memungkinkan, deploy sekali saja: kumpulkan SEMUA perbaikan kontrak (H-02, H-03, M-01) sebelum deploy pertama, karena tiap redeploy menambah risiko dan butuh gas.
- **Pemilik:** Agen 1 (keputusan top-up + anggaran demo) + Agen 3 (verifikasi saldo, perkecil wasm).

---

## LOW

### L-01 — Header wallet tidak mengikuti perubahan akun: setelah connect, tombol masih "Connect wallet" sampai refresh
- **File:** `frontend/src/components/WalletButton.tsx:10-14` (`useEffect` sekali saat mount, tidak subscribe ke `selector.store`), `frontend/src/lib/near.ts:43-47` (`accounts[0]` saja; tidak ada listener perubahan akun).
- **Bukti:** `getSignedInAccount()` hanya dibaca sekali. Setelah pengguna connect via modal, `WalletButton` tetap menampilkan "Connect wallet" sampai halaman di-refresh. Setelah `signOut`, halaman lain (Deploy/Policy) tetap menampilkan akun lama sampai refresh. `signOut` (`near.ts:49-53`) juga tanpa try/catch — bila `selector.wallet()` throw (tidak ada wallet), `WalletButton.tsx:16-19` mengalami unhandled rejection.
- **Perbaikan:** subscribe ke `selector.store.observable` / `on("signedIn"/"signedOut")` dan perbarui semua halaman; bungkus `signOut` dengan try/catch.
- **Pemilik:** Agen 3.

### L-02 — Bundle frontend 1,35 MB; warning `buffer`/`util`/`http`/`https`/`crypto` di-externalize saat build
- **File:** `frontend/package.json` (near-api-js 5 + wallet-selector 8), output `npm run build` (terverifikasi): `dist/assets/index-DjfsDEIt.js 1.347,95 kB (gzip 406,28 kB)`, warning chunk >500 kB + 5 modul Node di-externalize dari `safe-buffer`, `@near-js/providers`, `@near-js/accounts`.
- **Bukti:** Build sukses, tapi modul Node yang di-externalize berarti sebagian kode dependensi mengharapkan polyfill Node di browser — saat ini tampaknya tidak pecah (build + typecheck lolos), tetapi ini rapuh: satu jalur kode yang menyentuh `Buffer`/`crypto` di runtime bisa gagal di browser. Tidak ada `npm test` (tidak ada test frontend sama sekali — `package.json` tidak punya script `test`).
- **Perbaikan:** tambah `vite-plugin-node-polyfills` (atau `buffer` + alias) bila jalur `Buffer` dipakai; code-split rute (`React.lazy` untuk Deploy/Pay) untuk memangkas chunk awal; tambah minimal satu smoke test. Bukan penghambat demo.
- **Pemilik:** Agen 3.

### L-03 — Validasi input longgar: deskripsi >500 karakter, client tidak ada, self-invoice, `pay/:id` bukan angka — semua baru gagal di kontrak (gas terbuang) atau menampilkan pesan keliru
- **File:** `frontend/src/pages/NewInvoice.tsx:18-55` (tidak ada cek panjang deskripsi, keberadaan akun client, atau `client == seller`), `frontend/src/lib/near.ts:186-200` (`createInvoice` hanya cek `parseNearAmount`), `frontend/src/pages/PayInvoice.tsx:25` (`Number(id)` tanpa validasi — `/pay/abc` → `NaN` → `get_invoice(NaN)` error mentah, halaman menampilkan "Invoice not found" yang menyesatkan), `frontend/src/pages/Policy.tsx:71-78` (cek seller hanya suffix `.testnet`/`.near` — `".testnet"`, `"ALICE.TESTNET"`, `"x.testnet"` lolos).
- **Perbaikan:** `maxlength={500}` + penghitung karakter di deskripsi; validasi client dengan `view_account` sebelum submit (atau minimal regex akun NEAR yang benar); peringatkan bila `client == seller`; validasi `id` numerik di PayInvoice dan tampilkan "Invalid invoice link" bila bukan angka.
- **Pemilik:** Agen 3.

### L-04 — Halaman 1Click tampil interaktif untuk penerima `.testnet` padahal pasti ditolak; kolom refund hanya dicek `0x`
- **File:** `frontend/src/pages/PayInvoice.tsx:214-310` (seksi 1Click tampil untuk semua invoice Pending + client, `requestQuote` baru gagal di `assertMainnetRecipient`), `:82-86` (`refundTo.startsWith("0x")` — `"0x123"` lolos, gagal belakangan di API), `frontend/src/lib/intents.ts:178-183` (deadline quote hardcoded 48 jam; tidak ada validasi `refundTo` di lib).
- **Perbaikan:** bila `seller` berakhiran `.testnet`, nonaktifkan seksi 1Click di depan dengan penjelasan (bukan setelah klik); validasi `refundTo` dengan regex `/^0x[0-9a-fA-F]{40}$/`; tampilkan bahwa quote kering (dry) bisa berubah harganya sebelum "Reserve deposit address".
- **Pemilik:** Agen 3.

### L-05 — Daftar invoice dibatasi 100 tanpa pagination: melewati 100, Dashboard/CSV diam-diam salah
- **File:** `frontend/src/pages/Dashboard.tsx:22`, `frontend/src/pages/Invoices.tsx:23` (`listInvoices(1, 100)` hardcoded), `frontend/src/lib/near.ts:90-100` (tidak ada pembungkus `get_invoice_count` — view kontrak `get_invoice_count`, `lib.rs:363`, tidak pernah dipakai frontend).
- **Bukti:** Invoice #101+ tidak tampil, tidak masuk total Dashboard, dan tidak masuk CSV. Tidak ada indikasi "menampilkan 100 dari N". Untuk demo (belasan invoice) tidak terasa; untuk penggunaan nyata ini bug data.
- **Perbaikan:** pakai `get_invoice_count()` + pagination (tombol "Load more" / halaman), atau muat semua bila `count <= 500`. Tambah wrapper `getInvoiceCount()` di `near.ts`.
- **Pemilik:** Agen 3.

### L-06 — CSV memakai `formatNear` (4 desimal, dibulatkan) + tidak ada kolom `external_ref`: data bookkeeper kehilangan presisi dan asal settlement
- **File:** `frontend/src/lib/csv.ts:27` (`formatNear(inv.amount)` — `near.ts:229-231` memakai `formatNearAmount(yocto, 4)`), `:10-19` (header tanpa `external_ref`).
- **Bukti:** Invoice 0,00001 NEAR diekspor sebagai `0` NEAR; invoice 0,123456 NEAR menjadi `0,1235`. Untuk buku kas, ini kehilangan data. Kolom `external_ref` (bukti 1Click) tidak ikut, padahal `confirm_external_payment` justru mengandalkan kolom itu sebagai bukti.
- **Perbaikan:** ekspor `amount_near` presisi penuh (`formatNearAmount(yocto)` tanpa argumen presisi / atau kolom `amount_yocto` tambahan) dan tambah kolom `external_ref`.
- **Pemilik:** Agen 3.

### L-07 — Relayer: semua error dikembalikan sebagai HTTP 400, termasuk kegagalan server/RPC — frontend tidak bisa membedakan "input salah" vs "coba lagi"
- **File:** `relayer-server/server.mjs:262-265` (`catch` → `sendJson(res, 400, …)` untuk semua error), `:70-88` (`rpcQuery` tanpa timeout; `res.json()` bisa throw untuk respons non-JSON), `:199` (`Number(nonce)` — presisi hilang di atas 2^53; untungnya pesan kanonik memakai angka yang sama sehingga lolos secara tidak sengaja).
- **Perbaikan:** 400 hanya untuk validasi input; 502 untuk kegagalan RPC/kontrak, 500 untuk misconfig; tambah timeout. Validasi `nonce` sebagai string digit + `BigInt` bila perlu.
- **Pemilik:** Agen 3.

### L-08 — Dead code / API tak terpakai
- **File:** `frontend/src/lib/intents.ts:41` (`USDC_NEAR_ASSET` diekspor, tidak pernah dipakai — UI hanya menawarkan wNEAR sebagai tujuan), `:146` (`listIntentTokens()` tidak pernah dipanggil halaman mana pun), `frontend/src/lib/near.ts` (`getRelayer()` tidak pernah dipakai UI; `get_invoice_count` kontrak `lib.rs:363` tidak punya wrapper frontend), `frontend/src/pages/Invoices.tsx:9-11` (komentar "newest last" — daftar sebenarnya terurut menaik/tertua dulu).
- **Perbaikan:** hapus atau pakai (tawarkan USDC sebagai tujuan bila memang didukung; pakai `listIntentTokens` untuk memilih aset sumber dinamis). Perbaiki komentar urutan.
- **Pemilik:** Agen 3.

### L-09 — Copy tidak konsisten / stale + typo kecil
- **File:** `frontend/src/lib/config.ts:5-6` (komentar "NOT deployed yet in this scaffold (phase 1)" — sudah fase 2), `frontend/src/App.tsx:45-47` ("does not exist on testnet in this scaffold"), `contract/src/lib.rs:113` (pesan "at most 500 characters" padahal kode memeriksa `description.len()` = byte, bukan karakter — deskripsi emoji 500 karakter bisa >500 byte dan gagal), `contract/src/lib.rs:30-33` (komentar status "Pending / Paid / Refunded" — tidak menyebut `released`, padahal UI membedakan "Paid · escrow" vs "Paid · released"), `frontend/src/pages/Deploy.tsx:22` ("twinnear.testnet holds 4 NEAR" — hardcoded, akan basi setelah top-up), `frontend/src/pages/Policy.tsx:167-174` (tombol "Clear rules" tanpa dialog konfirmasi — satu klik menghapus seluruh proteksi spend-guard; ini perilaku berbahaya meski disengaja — sebaiknya tambah `confirm()`).
- **Perbaikan:** bersihkan komentar "scaffold/phase 1", samakan pesan 500 byte vs karakter, tambah konfirmasi pada "Clear rules", ganti angka saldo hardcoded dengan saldo live.
- **Pemilik:** Agen 3 (copy) — kecuali keputusan "Clear rules" tanpa konfirmasi, itu Agen 1.

### L-10 — Aksesibilitas dasar belum dipenuhi; seluruh UI berbahasa Inggris
- **File:** seluruh `frontend/src/**` (grep `role=` / `aria-` menghasilkan NOL hasil), `frontend/src/index.css` (tidak ada `:focus-visible` untuk tombol; warna teks redup `--ink-faint: #8a8272` di atas `--paper: #fdfbf6` kontrasnya sekitar 3,5:1 — di bawah 4,5:1 untuk teks kecil), `frontend/index.html` (`lang="en"`).
- **Bukti:** Pesan error/notice (`<div className="error">`, `<div className="notice">`) tidak punya `role="alert"`/`aria-live`, jadi screen reader tidak mengumumkannya; tabel ledger tanpa `<caption>`/`<th scope>`; navigasi tanpa `aria-label`; status hanya dibedakan warna + teks (teksnya ada — ini sudah benar); tidak ada indikasi fokus keyboard yang jelas pada tombol. Seluruh copy berbahasa Inggris, sementara pengguna utama berbahasa Indonesia (preferensi tercatat) — ini keputusan produk, bukan bug, tapi untuk demo berbahasa Indonesia patut dipertimbangkan.
- **Perbaikan:** tambah `role="alert"` pada error, `aria-live="polite"` pada notice, `scope="col"` + caption pada tabel, `:focus-visible` outline, naikkan kontras `--ink-faint` (mis. `#6b6355`). Bahasa UI → keputusan Agen 1.
- **Pemilik:** Agen 3 (a11y teknis); Agen 1 (keputusan bahasa).

### L-11 — Relayer: `/health` membocorkan info + tidak ada log audit server-side; `console.log` startup satu-satunya log
- **File:** `relayer-server/server.mjs:272-279` (`/health` mengembalikan `relayer` account id + `configured`), `:290-293` (satu `console.log`), tidak ada logging request sama sekali.
- **Bukti:** Info yang dibocorkan kecil (account id memang publik), tapi tidak ada jejak audit server-side bila terjadi sengketa ("siapa yang meminta relay invoice X?") — satu-satunya jejak adalah log on-chain `signature`/`public_key` di kontrak. Body tanpa batas (lihat M-07).
- **Perbaikan:** log setiap relay (timestamp, seller, invoiceId, txHash) ke stdout/file; pertimbangkan menyembunyikan `relayer` id dari `/health` publik bila server diekspos.
- **Pemilik:** Agen 3.

### L-12 — `create_invoice` mengizinkan self-invoice dan client yang tidak ada; `set_policy` mengizinkan allowlist tak terbatas/duplikat/akun tak valid
- **File:** `contract/src/lib.rs:102-146` (tidak ada cek `seller != client`, tidak ada cek eksistensi client, tidak ada batas `allowed_sellers.len()` di `:314-325`).
- **Bukti:** Seller bisa membuat invoice untuk dirinya sendiri atau untuk akun yang tidak pernah ada (client itu tidak akan pernah bisa membayar — invoice sampah permanen). `set_policy` menerima allowlist sepanjang apa pun, termasuk duplikat dan akun yang tidak valid — hanya merugikan diri sendiri (storage + gas), tapi bisa membuat `create_invoice` gagal dengan gas terbuang bila allowlist membengkak. Bukan jalur pencurian — dampaknya spam/polusi ledger.
- **Perbaikan:** tolak `seller == client` di kontrak; batasi `allowed_sellers` (mis. maks 50, dedup) dan validasi format akun di frontend (sudah sebagian ada di `Policy.tsx:71-78`, tapi longgar — lihat L-03).
- **Pemilik:** Agen 3 (kode); bila self-invoice dianggap fitur (pengujian), Agen 1 yang memutuskan.

---

## Yang diperiksa dan dinyatakan AMAN (tidak ada temuan)

- **Double-spend / pembayaran ganda:** `pay_invoice` mensyaratkan `Pending` + `payer == client` + deposit persis sama dengan jumlah (`lib.rs:244-267`); `release`/`refund` mensyaratkan `Paid` + `!released` (`:269-311`). Setelah dibayar, status berubah sehingga pembayaran kedua ditolak. ✅
- **Replay meta-tx:** nonce per-seller strictly-monotonik di kontrak (`:183-188`) + dicek ulang off-chain (`server.mjs:228-232`) + counter termasuk dalam pesan yang ditandatangani (`relayer.ts:95-102`). Satu tanda tangan = satu invoice. ✅ (Kelemahan yang tersisa adalah tidak adanya verifikasi on-chain — M-01 — bukan replay.)
- **Kontrol akses dasar:** `set_relayer` hanya owner (`:202-211`); `release`/`refund`/`confirm_external_payment` hanya seller (`:217-311`); `pay` hanya client (`:244-267`); `set_policy` hanya untuk diri sendiri (`:314-325`). Semua diuji unit test. ✅
- **Attached deposit / pembulatan:** `pay_invoice` menuntut deposit PERSIS sama (`assert_eq!`, `:260-264`) — tidak ada overpayment yang nyangkut, tidak ada pembulatan (semua yocto integer, tanpa pembagian). ✅
- **Overflow:** tidak ada aritmetika pada jumlah kecuali `next_invoice_id += 1` (overflow praktis mustahil, u64) dan `saturating_add/sub` di view (`:331-347`, `:367`). ✅
- **Deskripsi 500 byte:** batas ditegakkan (`:111-115`), hanya pesannya yang salah menyebut "characters" (L-09). ✅
- **NEP-413 Borsh di relayer:** struktur `borshPayload` (`server.mjs:31-50`) sesuai skema yang didokumentasikan (message + nonce 32 byte + recipient + `callbackUrl: None`); verifikasi byte-identical TIDAK dapat diuji ulang dari repo (tidak ada script pembanding) — tetap item click-through Meteor. ⚠️ belum terverifikasi, bukan temuan kode.
- **Tidak ada kunci/seed yang diminta atau dipakai** dalam audit ini; tidak ada transaksi yang dikirim; tidak ada repo GitHub yang dibuat. ✅

## Urutan perbaikan yang disarankan sebelum deploy

1. **H-01** (deteksi deploy) + **H-07** (silent no-limit) + **H-08** (top-up faucet → ≥6 NEAR, verifikasi saldo) — ketiganya murah, dan H-01 memblokir jalur deploy yang direkomendasikan.
2. **H-02** (callback transfer / rescue) + **H-05** (tutup jendela front-running init) — keduanya menyangkut keamanan dana/kepemilikan.
3. **H-03 + M-03** (deadline escrow + cek policy saat bayar) — keputusan desain Agen 1 dulu, karena mengubah struct `Invoice` dan harus masuk SEBELUM deploy pertama (migrasi struct setelah deploy jauh lebih mahal).
4. **H-04 + M-04 + M-07** (relayer: allowlist/rate-limit, lock per-seller, timeout) — sebelum relayer diekspos publik.
5. **M-02, M-05, M-06** (prefill/validasi 1Click, cek saldo/jaringan, tx hash + refresh yang benar) — kualitas demo.
6. **L-01–L-12** — polish; L-10 (a11y) dan L-09 ("Clear rules" confirm) murah dan terlihat di depan juri.

**Catatan deploy:** kumpulkan semua perbaikan kontrak (H-02, H-03, M-01 bila diputuskan, M-03) ke DALAM SATU build sebelum deploy pertama — redeploy setelah demo dimulai menambah biaya storage/gas dan risiko H-05/H-08 berulang.
