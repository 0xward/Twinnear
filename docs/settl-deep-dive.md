# Settl Deep Dive — Bedah Habis-Habisan + Rencana Twinnear Jadi Jauh Lebih Baik

**Tujuan:** Twinnear harus JAUHHH lebih baik dari Settl dari segi apapun — unggul di semua aspek.
**Tanggal riset:** 7 November 2026 malam (WIB). Deadline submission: **Minggu 15 Nov 2026 06:59 WIB**.
**Metode:** repo Settl di-clone dan dibaca penuh (kontrak + web + skrip demo + CI), situs live di-fetch, kontrak mainnet + testnet diverifikasi via RPC langsung, token 1Click dicek via API. Semua klaim di bawah ini terverifikasi dari sumber publik malam ini, kecuali yang ditandai "tidak terverifikasi".

---

## 1. Settl — profil singkat

| Item | Fakta |
|---|---|
| Repo | `ZSP111/settl` (publik, MIT), 42 commit, 3,8 MB |
| Builder | Peter Obisi — juga membangun **Heir** (crypto inheritance), di-disclose di README per aturan Q-015. Dibangun dengan bantuan Claude Code (di-disclose). |
| Terakhir aktif | **6 Nov 2026 15:12 UTC** (commit `9758fda`, docs) — ~24 jam sebelum riset ini. Semua aktivitas pembayaran on-chain-nya lebih tua lagi (lihat §3). |
| Demo testnet | https://web-seven-ruddy-87.vercel.app |
| Aplikasi mainnet | https://settl-mainnet.vercel.app |
| Kontrak | `settl-billonaire.testnet` · `settl-billonaire.near` |
| Track | Real-World Money (utama) · Unstoppable DeFi · Open Innovation |
| Tagline | "Invoices that settle themselves." |
| Video demo | **TIDAK ADA file video di repo** — hanya `docs/demo-script.md` (~2:05, 7 adegan). Video di X **tidak terverifikasi** (x.com diblokir fetch). |

**Produk dalam satu kalimat:** invoice berdenominasi **USDC saja**; klien bayar USDC dari dompet NEAR, atau bayar ETH/SOL/BTC/NEAR/USDC dari chain lain via NEAR Intents; kontrak membagi otomatis ke maksimal 5 kolaborator, atau menahan di escrow sampai klien approve; ada halaman bukti pemasukan publik `/proof/<account>`; pembuatan invoice bisa gasless (meta-transaction + sponsor pool).

---

## 2. Bedah kontrak Settl (dibaca penuh)

Kontrak Rust (near-sdk), total ~600 baris: `lib.rs` 253, `payment.rs` 192, `sponsor.rs` 64, `migrate.rs` 38, `invoice.rs` 51. **13 method publik.** Bandingkan: kontrak Twinnear 2.553 baris, 30 method publik.

### Yang ada
- **Invoice USDC** (`create_invoice`): client_name (maks 100), description (maks 1.000), amount USDC 6 desimal, due_date, splits, escrow flag. Deposit storage 0,05 NEAR (kelebihan dikembalikan) atau gratis dari sponsor pool.
- **Splits (max 5):** basis points yang harus berjumlah tepat 10.000; validasi bagus — akun duplikat ditolak, share 0 ditolak, kontrak sendiri tidak boleh jadi penerima (USDC menolak transfer ke diri sendiri). Pembagian membulatkan ke bawah, sisa dibulatkan ke split pertama sehingga total selalu pas.
- **Pembayaran (`ft_on_transfer`):** hanya menerima USDC dari kontrak USDC; amount harus PERSIS sama dengan invoice; invoice harus Unpaid; kalau salah, panic → USDC refund otomatis. `msg` berisi id invoice (`"12"`) atau JSON `{"invoice_id": 12, "payer": "client.near"}` (untuk pembayaran via Intents, pengirimnya `intents.near`).
- **Escrow:** bila `escrow=true`, status jadi `Escrowed`; `release_escrow` hanya boleh dipanggil payer. Setelah release, split dibayarkan.
- **Payout anti-hilang:** setiap transfer USDC punya callback; bila gagal (mis. penerima belum registrasi di USDC), share disimpan sebagai pending balance dan bisa ditarik via `withdraw()`. Bila gas tidak cukup untuk semua transfer, semua share masuk pending balance.
- **Sponsor pool:** siapa pun bisa `fund_sponsor_pool()`; invoice tanpa deposit dibayar storagenya dari pool, **maks 10 invoice per akun** (cap, bukan rate-limit — diakui sendiri sebagai keterbatasan).
- **Migrasi:** `migrate()` ada — penambahan sponsor pool mengubah layout state dan migrasi menjaga semua invoice (testnet + mainnet).
- **Cancel:** `cancel_invoice` hanya creator, hanya saat Unpaid.

### Yang TIDAK ada (celah struktural — ini yang kita serang)
1. **Tidak ada dispute / refund / timeout escrow SAMA SEKALI.** Bila klien tidak pernah approve, dana terkunci di kontrak **selamanya** — tidak ada jalan keluar untuk freelancer (tidak bisa paksa release) maupun klien (tidak bisa minta refund). Escrow Settl bisa deadlock permanen. Twinnear punya `open_dispute` / `withdraw_dispute` / `claim_refund` / `refund_invoice` / `rescue_escrow` — siklus hidup lengkap.
2. **`due_date` hanya informasional** — komentar kode sendiri: "Unix time in milliseconds. Informational only: the contract does not enforce it." Invoice kedaluwarsa tidak bisa ditagih/dibatalkan otomatis.
3. **Satu mata uang:** invoice HANYA USDC. Tidak ada invoice NEAR (Twinnear punya NEAR + USDC).
4. **Tidak ada line items / pajak.** Hanya satu amount + satu deskripsi teks.
5. **Tidak ada retainer / invoice berulang.**
6. **Tidak ada spend-guard** (max_amount, daily cap, allowlist) — tidak ada konsep policy sama sekali.
7. **Tidak ada portal klien** — klien hanya punya link bayar; tidak bisa melihat daftar invoice-nya.
8. **Tidak ada PDF yang di-generate** (hanya tombol `window.print()` di halaman proof) dan **tidak ada CSV**.
9. **Tidak ada estimasi fiat.**
10. **Tidak ada validasi live akun saat mengetik** — form hanya mengecek registrasi USDC penerima split saat submit (bila akun salah ketik, transaksi registrasi gagal di submit, tanpa ✓/✗ saat mengetik seperti Twinnear).
11. **Tidak ada test adversarial / fuzz / conformance** — hanya 51 unit test + 4 e2e sandbox.

### Gasless Settl — beda mekanisme dari Twinnear
- Settl memakai **NEP-366 delegate action** (dompet menandatangani delegate action; relayer membungkus dan membayar gas). Twinnear memakai **NEP-413 signed message** (pesan ditandatangani, server verifikasi, relayer submit).
- Relayer Settl hanya mengizinkan `create_invoice`, `cancel_invoice`, `release_escrow` ke kontrak Settl, tanpa deposit, maks 2 aksi, maks 100 TGas (`relayPolicy.ts`). Relayer juga mendaftarkan penerima split di USDC (storage deposit) — detail yang rapi.
- **Gasless hanya di testnet** — diakui sendiri di README: "On mainnet the relayer and sponsor pool would spend real NEAR". Pool testnet terverifikasi **0,99227 NEAR**; pool mainnet terverifikasi **0** (kosong).
- Bukti gasless mereka: invoice #8 testnet ("Gasless Test", dibuat gasless dari Meteor asli, saldo NEAR freelancer tidak berubah sampai yoctoNEAR) — **tapi invoice #8 sekarang berstatus Cancelled** (dibuat lalu dibatalkan, tidak pernah dibayar). Bukti gasless Twinnear lebih kuat: invoice #4 **terbayar on-chain** via gasless (tx `2iMVmF156UnK3WR1nHJxnwgCYSisy8585NNGQtBKnXz4`).

### Pengujian Settl (terverifikasi dari kode, bukan klaim README)
- **51 `#[test]`** (dihitung grep: `invoices.rs`, `payments.rs`, `sponsor.rs`, `migration.rs`) + **4 e2e sandbox** (`tests/payment_flow.rs`, 296 baris: split payment, wrong-amount refund, escrow lalu release, payout ke akun belum registrasi lalu withdraw).
- **CI GitHub Actions (lebih ketat dari Twinnear):** `cargo fmt --check`, `cargo clippy --tests -- -D warnings`, unit test, e2e sandbox (install cargo-near), web `npm run lint` + `npx next typegen` + `tsc --noEmit` + `npm run build`.
- Twinnear saat ini: 51 unit test (setara), CI hanya `cargo test --release` + `npm run build` (tanpa fmt/clippy/lint/tsc), dan **test adversarial/conformance sedang ditambahkan agen lain** — jangan duplikasi.

---

## 3. Bukti on-chain Settl (diverifikasi via RPC malam ini)

| Klaim | Hasil verifikasi |
|---|---|
| Mainnet invoice #1: dibayar via Intents, 1,00 USDC | ✅ TERVERIFIKASI. `{"id":1,"creator":"bluecheese8363.near","client_name":"Intents test","description":"First mainnet payment","amount":"1000000","escrow":false,"status":"Paid","payer":"intents.near"}` |
| Mainnet: 4 invoice dari bluecheese8363.near (id 1–4) | ✅ TERVERIFIKASI. Saldo kontrak mainnet **2,307 NEAR**. |
| Testnet invoice #4: split 70/30, 2,00 USDC | ✅ TERVERIFIKASI. `{"id":4,"creator":"billonaire.testnet","amount":"2000000","splits":[{"billonaire.testnet":7000},{"billonaire-collab.testnet":3000}],"status":"Paid","payer":"billonaire.testnet"}` |
| Testnet invoice #5: escrow → release | ✅ TERVERIFIKASI. `{"id":5,"escrow":true,"status":"Paid"}` |
| Testnet invoice #8: gasless | ⚠️ SEPARUH. Invoice #8 ada ("Gasless Test", 1,00 USDC) tapi statusnya sekarang **Cancelled** — dibuat gasless, lalu dibatalkan, tidak pernah dibayar. |
| Aktivitas | ⚠️ TIPIS DAN BERHENTI. Semua invoice testnet yang terbayar (#2–#5) dibayar **28 Okt 2026** — satu hari saja. Satu-satunya aktivitas Nov adalah pembuatan invoice #8 (6 Nov, lalu dibatalkan). Total footprint on-chain: **9 invoice** di kedua jaringan (5 testnet + 4 mainnet), semuanya tes $1–2. Twinnear: 4 invoice testnet dengan alur kerja nyata (buat → bayar → release → retainer). |
| Kontrak USDC mainnet | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC resmi NEAR) ✅ |

**Vonis jujur soal mainnet Settl:** mainnet-nya NYATA (bukan klaim kosong — invoice #1 terbayar via `intents.near` bisa dicek siapa pun), tapi **tipis**: 4 invoice dari satu akun, semuanya tes kecil. Ini satu-satunya sumbu di mana Settl menang atas Twinnear — dan kemenangannya adalah "ada mainnet", bukan "mainnet yang ramai".

---

## 4. Bedah web Settl (dibaca penuh + situs live di-fetch)

Stack: Next.js 16, Tailwind 4, `@hot-labs/near-connect` (Meteor, HOT, Intear, Ledger, …). 32 file sumber. Halaman: home, dashboard, invoices/new, invoices/[id], pay/[id], proof/[account].

### Desain (dilihat dari screenshot repo + situs live)
- **Gaya: SaaS biru generik yang sangat rapi** — latar abu muda, kartu putih, aksen biru terang, font sans tebal, hero "Invoices that settle themselves." + mockup HP halaman bayar. Terlihat seperti produk startup sungguhan; mudah dipahami juri mana pun dalam 5 detik.
- **Kelemahan desain:** tidak punya identitas visual yang khas — ini template SaaS yang bisa jadi milik siapa saja. Desain paper Twinnear (kertas krem, serif, tinta hijau, logo paper-cut) jauh lebih mudah diingat. Ini keunggulan yang harus dipertahankan, bukan ditiru.

### Halaman-halaman
- **Home:** hero + "Your client pays with" (pil USDC/ETH/SOL/BTC/NEAR) + How it works (3 langkah) + 6 kartu fitur + seksi "Proven on NEAR" (3 kartu bukti yang mengarah ke receipt live: mainnet #1, split testnet #4, income proof) + footer (kontrak + Dashboard + GitHub, hanya di testnet).
- **New invoice:** form rapi — Client, What is it for?, Amount (USDC) + Due date, editor split (akun + persen, total harus 100%, preview share live "1.40 / 0.60 USDC"), checkbox escrow, tombol Create, catatan "Free: Settl pays the network fee and storage" bila gasless terdeteksi (atau "costs a tiny NEAR deposit" bila tidak). **Tidak ada validasi live akun** saat mengetik; tidak ada line items/pajak.
- **Pay (`/pay/[id]`, phone-first):** ringkasan invoice (amount besar, billed to, due, for), kartu "Pay with USDC on NEAR" (cek saldo USDC, tombol Pay), kartu "Pay with ETH, SOL, BTC or other USDC" (9 pil token, field alamat refund dengan validasi per jenis alamat, quote live "You send about 0.000436726 ETH ($1.01), Arrives in about 35 seconds", QR code alamat deposit, status swap live yang di-poll tiap 5 detik, deposit tersimpan di localStorage supaya refresh tidak hilang, tombol kirim via dompet NEAR untuk opsi NEAR — wrap NEAR → wNEAR → kirim dalam satu transaksi). **Ini bagian web Settl yang paling kuat — alur bayar lintas-chain yang matang.** Bila invoice escrow, opsi Intents dinonaktifkan dengan penjelasan (escrow butuh tanda tangan NEAR payer).
- **InvoiceView (freelancer):** link bayar + Copy / Share on WhatsApp / Send by email, ringkasan + split breakdown, tombol Cancel (dengan confirm dialog).
- **Dashboard:** daftar invoice + total Paid/Outstanding/In escrow + pending balance (withdraw) + tautan income proof.
- **Proof (`/proof/<account>`):** total diterima (hanya share sendiri), jumlah invoice terbayar, periode, rincian per bulan, daftar pembayaran, tombol Copy link + "Save as PDF" (window.print), kartu "How to verify this" (menjelaskan cara cek via `get_invoices_by_creator`). **Keterbatasan yang diakui sendiri:** hanya invoice yang dibuat akun itu — share yang diterima sebagai kolaborator orang lain tidak tercatat (kontrak tidak punya indeks per penerima).

### Dokumentasi Settl (sangat kuat — ini yang harus kita samai/lewati)
- README ditulis untuk juri: tabel "Try it in 2 minutes (no wallet needed)" (do X → see Y), diagram mermaid arsitektur, tabel "Verified on-chain" (6 baris bukti), Contract API lengkap, "Known limitations" yang jujur (5 butir), disclosure proyek kedua (Heir) + AI tools.
- `demo-script.md` matang (7 adegan, termasuk bayar mainnet nyata ~$1, checklist pasca-rekam).
- `HACKATHON.md` berisi seluruh aturan + payload submission (mereka menyalin HACKATHON.md resmi ke repo).
- `web/README.md` + `web/AGENTS.md` + `CLAUDE.md` (instruksi agen).
- **Yang Twinnear sudah samai:** `verify-in-2-minutes.md`, About/FAQ jujur, Docs, Mainnet readiness, README dengan "Live status". **Yang Twinnear belum punya:** seksi "Proven on NEAR" di homepage yang mengarah ke receipt live (punya bahan lengkapnya, belum dirangkai), dan skrip demo yang sedetail Settl (skrip Twinnear ada, tapi belum sedetail per-adean dengan checklist).

---

## 5. Cara kerja pembayaran Twinnear — menjawab pertanyaan pengguna

> "Sistemnya gimana ini invoice-nya, apa orang kirim USDC terus jadi NEAR, atau bisa ETH, USDT dll?"

**Jawaban singkat: dua arah, tergantung mata uang invoice — dan USDT belum ada, tapi bisa ditambahkan dengan mudah.**

### Invoice berdenominasi NEAR (jalur utama Twinnear)
1. **Bayar langsung NEAR:** klien bayar NEAR ke kontrak (`pay_invoice`) → dana masuk **escrow on-chain** → seller release setelah kerja selesai (atau dispute/refund bila ada masalah). Ini jalur yang terverifikasi end-to-end (invoice #1: bayar + release, tx nyata).
2. **Bayar via 1Click/Intents (mainnet-only):** klien kirim **USDC (Base / Ethereum / Arbitrum)** atau **ETH (Ethereum)** dari dompet chain asal → solver 1Click menukar → **wNEAR dikirim langsung ke akun NEAR seller** → seller menutup invoice on-chain via `confirm_external_payment` (mencatat alamat deposit 1Click sebagai referensi). **Catatan jujur:** penutupan ini bersifat attested oleh seller — 1Click tidak mengirim ke kontrak, jadi tidak lewat escrow. Quote terverifikasi live: 10 USDC Base → 9,99436 USDC NEAR; 0,05 ETH → 29,615 wNEAR.

### Invoice berdenominasi USDC
- Via 1Click: USDC dari chain asal dikirim **langsung ke seller** (bukan ke kontrak), seller menutup via `confirm_external_payment`. Sama seperti di atas: attested, tidak lewat escrow. (Kontrak punya `on_transfer_callback` untuk penerimaan USDC ke kontrak — jalur ini ada di kode, tapi alur USDC yang didokumentasikan saat ini adalah seller-direct.)
- **Celah yang sedang diperbaiki (kontrak v4, agen lain — jangan duplikasi):** invoice USDC saat ini melewati `max_amount` dan daily cap spend-guard (hanya allowlist yang berlaku). v4 menambahkan `UsdcPolicy` (cap dalam micro-USDC, ditegakkan di create + di konfirmasi).

### USDT — belum ada, dan ini peluang
- **Twinnear hari ini:** 4 opsi sumber — USDC Base, USDC Ethereum, ETH Ethereum, USDC Arbitrum. **Tidak ada USDT, SOL, BTC, atau NEAR-sebagai-sumber.**
- **Settl hari ini:** 9 opsi — ETH Base/Arbitrum/Ethereum, USDC Base/Arbitrum/Solana, SOL, BTC, NEAR. **Juga tidak ada USDT.**
- **1Click mendukung USDT (terverifikasi via API malam ini):** `/v0/tokens` = 216 token, **22 entri USDT** — Ethereum (`0xdac17f958d2ee523a2206206994597c13d831ec7`), Solana, Tron (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`), NEAR (`usdt.tether-token.near`), BSC, dan lain-lain. Harga ~$0,99924.
- **Artinya:** menambah **USDT (Ethereum/Arbitrum/Base)** ke Twinnear hanya butuh tambah `assetId` + label di `SOURCE_ASSETS` — karena refund address-nya EVM (regex `0x...` sudah ada di PayInvoice). USDT Tron/Solana dan sumber SOL/BTC butuh validasi jenis alamat tambahan (sedang). **Rekomendasi: tambah USDT EVM dulu (kecil), lalu SOL + BTC + NEAR-untuk-invoice-USDC (sedang).** Hasilnya: 11 opsi vs 9 milik Settl — dan USDT adalah token yang **tidak dimiliki siapa pun** di track ini.

### Perbedaan arsitektur yang paling penting vs Settl
- **Settl:** pembayaran Intents mendarat **di kontrak** (`ft_transfer_call` + `customRecipientMsg` = id invoice) → `ft_on_transfer` menandai terbayar dan membagi/escrow. **Terverifikasi on-chain, termasuk untuk pembayaran lintas-chain.**
- **Twinnear:** pembayaran Intents mendarat **di seller langsung** → seller yang menutup invoice (attested). Lebih sederhana, tapi lebih lemah buktinya — dan invoice USDC tidak bisa escrow.
- **Ini celah arsitektur terbesar Twinnear vs Settl** — lihat rekomendasi #7 (v5).

---

## 6. Tabel perbandingan Twinnear vs Settl (aspek demi aspek)

| Aspek | Twinnear | Settl | Pemenang |
|---|---|---|---|
| **Invoice** | NEAR + USDC, line items + pajak | USDC saja, satu amount + deskripsi | 🏆 Twinnear |
| **Escrow** | ✅ + dispute + refund + claim_refund + rescue_escrow + cancel | ✅ hold + release payer-only; **tanpa dispute/refund/timeout — bisa deadlock selamanya** | 🏆 Twinnear (jauh) |
| **Splits kolaborator** | ❌ tidak ada | ✅ maks 5, otomatis saat bayar, anti-hilang (pending balance + withdraw) | 🏆 Settl |
| **Retainer / berulang** | ✅ (`/recurring`) | ❌ | 🏆 Twinnear |
| **Portal klien** | ✅ (`/portal`) | ❌ (hanya link bayar) | 🏆 Twinnear |
| **PDF / CSV** | ✅ PDF di-generate (jsPDF) + CSV | ⚠️ hanya `window.print()`; tanpa CSV | 🏆 Twinnear |
| **Spend-guard** | ✅ max_amount + daily cap + allowlist (NEAR; USDC di v4 — sedang dikerjakan agen lain) | ❌ tidak ada konsep policy | 🏆 Twinnear |
| **Estimasi fiat** | ✅ CoinGecko | ❌ | 🏆 Twinnear |
| **Validasi live akun** | ✅ ✓/✗ saat mengetik (debounce, cek RPC) | ❌ hanya cek registrasi USDC saat submit | 🏆 Twinnear |
| **Halaman invoice publik (tanpa wallet)** | ✅ `#/invoice/:id` + `#/pay/:id` | ✅ `/pay/[id]` + `/proof/[account]` | Seri (keduanya kuat) |
| **Bukti pemasukan publik** | ⚠️ ada PublicInvoice + Dashboard, tapi **belum ada halaman ringkasan bulanan ala `/proof/`** | ✅ `/proof/` (total, per bulan, periode, daftar) | 🏆 Settl (kecil) |
| **Sumber bayar 1Click** | 4 (USDC Base/Eth/Arb, ETH Eth) | 9 (ETH×3, USDC×3, SOL, BTC, NEAR) | 🏆 Settl |
| **USDT** | ❌ | ❌ | Seri — **peluang untuk keduanya; siapa cepat dia menang** |
| **Intents → kontrak (terverifikasi on-chain)** | ❌ (ke seller langsung, attested) | ✅ (ke kontrak, `ft_on_transfer`) | 🏆 Settl |
| **Gasless** | ✅ NEP-413, terbukti end-to-end + invoice #4 TERBAYAR on-chain; relayer allowlist + rate-limit + nonce on-chain | ✅ NEP-366 + sponsor pool (10/akun); bukti invoice #8 **dibatalkan, tidak terbayar**; gasless **testnet-only** | 🏆 Twinnear (bukti lebih kuat) |
| **Kontrak** | 2.553 baris, 30 method, v3 live (+ v4 di working tree) | ~600 baris, 13 method | 🏆 Twinnear (cakupan) |
| **Pengujian** | 51 unit; adversarial/conformance **sedang ditambah agen lain** | 51 unit + 4 e2e sandbox; tanpa adversarial | Seri hari ini; Twinnear akan unggul bila agen test selesai |
| **CI** | Ada (cargo test + npm build) — tanpa fmt/clippy/lint/tsc | ✅ fmt + clippy `-D warnings` + e2e sandbox + lint + typegen + tsc + build | 🏆 Settl (kecil) |
| **Mainnet** | ❌ testnet-only (disengaja; butuh ~2,5 NEAR) | ✅ live, 4 invoice, 1 pembayaran Intents nyata $1 | 🏆 Settl (satu-satunya sumbu keras mereka) |
| **Aktivitas on-chain** | 4 invoice testnet, alur lengkap (bayar, release, retainer, gasless) | 9 invoice total, semua tes $1–2; semua pembayaran testnet **28 Okt**; tidak ada aktivitas bayar sejak itu | 🏆 Twinnear (lebih hidup) |
| **Momentum** | Aktif sampai malam 7 Nov (push terakhir 21:55 WIB) | Terakhir push 6 Nov 15:12 UTC; tidak ada commit bayar sejak 28 Okt | 🏆 Twinnear |
| **UX bayar lintas-chain** | Ada (quote + deposit + status polling), tapi opsi lebih sedikit dan tanpa QR | ✅ Sangat matang: 9 pil, QR deposit, polling 5 detik, localStorage, kirim NEAR sekali ketuk | 🏆 Settl |
| **Desain** | Paper (kertas krem, serif, tinta hijau, logo paper-cut) — khas, mudah diingat | SaaS biru generik — sangat rapi, tapi bisa milik siapa saja | 🏆 Twinnear (identitas); Settl (kehalusan umum) |
| **Dokumentasi** | README + About/Docs/FAQ + verify-in-2-minutes + Mainnet readiness + pengakuan celah USDC | README untuk juri + demo-script detail + diagram + "Verified on-chain" + Known limitations + HACKATHON.md | Seri — Settl sedikit lebih rapi di "bukti", Twinnear lebih jujur di "celah" |
| **Video demo** | ❌ belum ada (dibuat pengguna besok/lusa) | ❌ tidak ada file video (hanya skrip matang) | Seri — **siapa yang upload duluan menang** |
| **Orisinalitas** | Kombinasi gasless + escrow + dispute + retainer + portal + PDF/CSV + spend-guard | Splits otomatis + income proof + Intents-ke-kontrak | Seri — keduanya invoice, tapi kombinasinya beda |

**Skor kasar:** Twinnear unggul di ~15 aspek, Settl di ~7 aspek, seri di ~5. Satu-satunya keunggulan Settl yang "keras" (sulit dibantah juri): **mainnet live + Intents-ke-kontrak**. Semua keunggulan Settl yang lain bisa ditutup dalam 1–2 hari kerja.

---

## 7. Tiga kelemahan terbesar Settl yang bisa kita serang

1. **Escrow tanpa jalan keluar (deadlock permanen).** Ini kelemahan fungsional paling serius: klien yang tidak approve = dana terkunci selamanya; kerja yang buruk = klien tidak bisa refund. Tidak ada dispute, refund, atau timeout — di kontrak maupun di UI. **Serangan:** di video + README + FAQ, tunjukkan alur Twinnear yang Settl tidak bisa lakukan: bayar → buka dispute → klaim refund → dana kembali. Satu adegan video 15 detik ("Settl can't do this") sudah cukup. Ini juga bahan juri teknis: "apa yang terjadi bila klien menghilang?" — Settl tidak punya jawaban.
2. **Mainnet tipis + aktivitas berhenti.** Mainnet mereka = 4 invoice tes dari satu akun; semua pembayaran testnet terjadi 28 Okt, lalu diam. Produk yang tidak dipakai setelah demo awal. **Serangan:** jangan menyerang mainnet-nya (itu nyata) — serang **kedalamannya**: halaman "Proven on NEAR" Twinnear dengan 4 invoice testnet yang masing-masing menunjukkan fitur berbeda (bayar, release, retainer, gasless) + tx hash, vs 4 invoice Settl yang semuanya tes $1 yang sama. Dan jaga momentum: push + aktivitas sampai 14 Nov.
3. **Satu mata uang, satu amount, tanpa alat bisnis.** Tidak ada invoice NEAR, line items, pajak, retainer, portal, PDF/CSV, spend-guard, estimasi fiat, atau validasi akun. Untuk "sesuatu yang bisa dipakai perusahaan normal besok" (brief track 08), Twinnear sudah lebih mirip produk bisnis utuh. **Serangan:** di homepage + video, tekankan "bukan cuma link bayar — ini buku kas": line items + pajak + PDF + CSV + retainer + portal + spend-guard. Settl tidak bisa membalas tanpa menulis ulang produknya.

---

## 8. Tiga keunggulan Twinnear yang harus ditonjolkan

1. **Bukti gasless end-to-end yang paling kuat di track.** Satu-satunya invoice gasless dengan transaksi TERBAYAR on-chain (invoice #4, tx `2iMVmF156UnK3WR1nHJxnwgCYSisy8585NNGQtBKnXz4`): tanda tangan NEP-413 Meteor → verifikasi server → submit relayer → invoice on-chain, seller bayar 0 gas. Settl hanya punya invoice gasless yang dibatalkan. **Tampilkan tx hash ini di homepage, video, dan README — jangan sembunyikan di docs.**
2. **Siklus hidup invoice yang lengkap (escrow + dispute + refund).** Satu-satunya di track 08 dengan `open_dispute` / `claim_refund` / `rescue_escrow` on-chain. Ini jawaban atas pertanyaan juri yang paling sulit ("lalu kalau ada masalah?") — dan Settl tidak punya jawabannya.
3. **Produk bisnis utuh, bukan cuma link bayar.** Retainer + portal klien + PDF + CSV + spend-guard + estimasi fiat + validasi live akun + desain paper yang khas. Tidak ada pesaing yang punya kombinasi ini. **Framing untuk juri:** "Settl adalah link bayar yang bagus. Twinnear adalah buku kas freelancer."

---

## 9. Rencana "jauh lebih baik di semua aspek" (sebelum 15 Nov 06:59 WIB)

### Sudah berjalan — JANGAN duplikasi
- **Agen kontrak:** 20–30 test adversarial/conformance + kontrak **v4** (UsdcPolicy, cap USDC). Deploy + migrate via Termux oleh pengguna.
- **README:** sudah diperbaiki (schema v3, 51 test, commit `50574813`).
- **Video:** dibuat pengguna besok/lusa (skrip sudah ada).
- **Payout address:** pengguna buat sendiri nanti (jangan dibuatkan).

### Tier 1 — Wajib, sebelum video/submit (dampak tertinggi)
| # | Tindakan | Usaha | Dampak | Detail |
|---|---|---|---|---|
| 1 | **Tambah USDT (+ SOL/BTC/NEAR) ke opsi bayar 1Click** | Kecil (USDT EVM) / Sedang (SOL/BTC/NEAR) | **Tinggi** | USDT Ethereum/Arbitrum/Base: tambah `assetId` + label di `SOURCE_ASSETS` (`frontend/src/lib/intents.ts`) — refund address EVM sudah divalidasi. USDT di 1Click terverifikasi: 22 entri, harga ~$0,99924. SOL/BTC/NEAR: tambah validasi jenis alamat (Solana base58, Bitcoin, akun NEAR) di `PayInvoice.tsx` — saat ini regex hanya EVM. Hasil: **11 opsi vs 9 milik Settl**, dan USDT tidak dimiliki siapa pun. Ini juga menjawab pertanyaan pengguna ("bisa USDT?") dengan produk, bukan janji. |
| 2 | **Halaman "Proven on NEAR" di homepage + tautan receipt live** | Kecil | Tinggi | Tiru struktur Settl yang terbukti efektif (3 kartu bukti), tapi dengan isi yang lebih kuat: (a) invoice #1 — bayar + release escrow, tx `GWzwgrct…` / `ARUyJbgZ…`; (b) invoice #4 — gasless, tx `2iMVmF156…`; (c) invoice #2 — retainer 1,01 NEAR. Tiap kartu: judul klaim + satu kalimat + tautan ke `#/invoice/:id` + NearBlocks. Ini menutup satu-satunya kekurangan presentasi bukti Twinnear vs Settl. |
| 3 | **Adegan dispute/refund di video** | Kecil (bagian dari video) | Tinggi | Tambah 1 adegan ~15 detik ke skrip video: bayar → buka dispute → klaim refund → dana kembali. Ini adegan yang **secara harfiah tidak bisa dibuat Settl**. Sertakan teks di layar: "The contract resolves it — not a support ticket." |
| 4 | **Uji portal sebagai 0xward.testnet** | Kecil | Sedang | Jalur demo yang belum teruji = risiko gagal saat juri mencoba. Uji + catat hasilnya. |

### Tier 2 — Menutup celah keras vs Settl (1–2 hari)
| # | Tindakan | Usaha | Dampak | Detail |
|---|---|---|---|---|
| 5 | **1Click USDC → kontrak (v5, setelah v4 deploy)** | Sedang–besar | **Tinggi** | Arsitektur: untuk invoice USDC, 1Click mengirim USDC ke **kontrak** (bukan seller) dengan `customRecipientMsg` = id invoice; kontrak `ft_on_transfer` menandai terbayar + escrow bila diminta. Ini menyamakan Twinnear dengan Settl di sumbu "Intents terverifikasi on-chain" SEKALIGUS membuat invoice USDC bisa escrow (yang hari ini tidak bisa). Butuh: perubahan kontrak (v5) + frontend (recipient = kontrak untuk invoice USDC) + test + deploy/migrasi. **Jangan mulai sebelum v4 selesai deploy** — satu agen kontrak, berurutan. |
| 6 | **Payout splits kolaborator (v5, bersama #5)** | Sedang | Tinggi | Satu-satunya fitur Settl yang Twinnear tidak punya. Desain mengikuti pola Settl (basis points, total 10.000, validasi duplikat + kontrak-bukan-penerima) + pola pending-balance/withdraw bila transfer gagal. Bisa digabung dalam v5 yang sama. Bila waktu tidak cukup, jadikan "roadmap v5" di Docs — tapi usahakan dibangun, karena ini satu-satunya baris tabel di mana Settl menang fitur. |
| 7 | **Ringkasan pemasukan bulanan (ala `/proof/` Settl)** | Kecil–sedang | Sedang | Tambah ke Dashboard/portal: total diterima, jumlah invoice terbayar, periode, rincian per bulan — dari `list_invoices` yang sudah ada. Ini menutup satu-satunya keunggulan presentasi Settl di "bukti pemasukan". CSV per bulan sudah ada polanya (`csv.ts`). |

### Tier 3 — Polish yang membedakan (kecil, cepat)
| # | Tindakan | Usaha | Dampak | Detail |
|---|---|---|---|---|
| 8 | **Keraskan CI** | Kecil | Sedang | Samai Settl: `cargo fmt --check`, `cargo clippy --tests -- -D warnings`, `npm run lint`, `tsc --noEmit` di `.github/workflows/ci.yml`. Sinyal disiplin untuk screening AI + juri teknis. |
| 9 | **Widget quote mainnet live di situs (tanpa dana bergerak)** | Kecil | Sedang | 1Click mainnet-only dan quote dry-run sudah terverifikasi live. Tambah kartu kecil di Docs/About: quote dry-run live (mis. 10 USDC Base → ~9,99 USDC NEAR) dengan cap waktu — membuktikan jalur mainnet Twinnear bekerja tanpa perlu deploy mainnet. Ini jawaban elegan atas "tapi kalian testnet-only". |
| 10 | **Perkuat copy homepage: "buku kas, bukan link bayar"** | Kecil | Sedang | Satu baris di hero + satu kartu fitur "Dispute & refund on-chain" + satu kartu "Recurring retainers". Settl punya 6 kartu fitur; Twinnear harus punya 8–9 kartu yang masing-masing adalah hal yang Settl tidak punya. |
| 11 | **Submit lebih awal (sebelum 14 Nov) + post X dengan video** | Kecil | Sedang | Hindari antrean deadline; tag @NEARProtocol + #NEARHackathon, dari @arawrdn. |

### Kesenjangan mainnet — opsi jujur
- **Fakta:** deploy mainnet butuh ~2,5 NEAR yang pengguna tidak punya; testnet-only **diizinkan semua track (Q-010)**. Tidak ada jalan pintas yang jujur.
- **Opsi A (dipilih):** tetap testnet-only + buktikan keunggulan testnet tak terbantahkan (video + adversarial + bukti on-chain + Tier 1–3). Ini rencana utama laporan ini.
- **Opsi B (bila 2,5 NEAR tersedia):** deploy kontrak mainnet + 1 invoice nyata $1 seperti Settl #1 — menutup satu-satunya sumbu keras Settl. Hanya bila dana ada; jangan memaksakan.
- **Opsi C (gratis, lakukan apa pun yang terjadi):** Tier 1 #9 — quote mainnet live di situs membuktikan jalur settlement mainnet bekerja, tanpa deploy.
- **Yang TIDAK boleh dilakukan:** mengklaim mainnet padahal testnet, atau menyebut invoice testnet sebagai "pembayaran nyata".

### Urutan kerja 8 hari (7 → 15 Nov)
- **7 Nov malam:** Tier 1 #1 (USDT EVM) + #2 (Proven on NEAR) + #4 (uji portal) — fondasi kecil.
- **8–9 Nov:** video (rekam + edit + post) + Tier 1 #3 (adegan dispute di video).
- **10–11 Nov:** agen test + v4 deploy/migrasi; Tier 2 #7 (ringkasan bulanan) + Tier 3 #8 (CI) + #10 (copy).
- **12–13 Nov:** Tier 2 #5 + #6 (v5: Intents-ke-kontrak + splits) — hanya bila v4 sudah live dan waktu cukup; bila tidak, jadikan roadmap terdokumentasi.
- **14 Nov:** submit + buffer. **15 Nov 06:59 WIB: deadline.**

---

## 10. Metodologi & ketidakpastian (jujur)

- **x.com diblokir untuk fetch** — video/klaim Settl di post X berstatus **tidak terverifikasi**, bukan "tidak ada". Jangan jadikan dasar klaim keunggulan.
- **Jumlah test Settl (51 + 4)** dihitung dari kode (grep `#[test]` + file e2e), bukan hanya README. Jumlah test Twinnear (51) dari `lib.rs`.
- **Nilai on-chain** (invoice #1/#4/#5/#8, pool sponsor, saldo kontrak) dibaca langsung via RPC mainnet/testnet malam ini, bukan dari README Settl.
- **Peran `on_transfer_callback` Twinnear** untuk USDC belum dibaca penuh — alur USDC yang dideskripsikan di §5 adalah alur yang didokumentasikan (1Click → seller → `confirm_external_payment`); verifikasi detail callback diserahkan ke agen kontrak.
- **Data API hackathon** berubah tiap hari; angka 244 aplikasi dari studi sebelumnya, bukan dihitung ulang di sini.
- **Tidak ada rubrik berbobot 2026 yang dipublikasikan** — kriteria juri memakai panduan historis (technical implementation, design, impact, originality, sustainability).
- File mentah riset: `/tmp/settl` (clone repo Settl), `/tmp/oneclick-tokens.json` (216 token 1Click).
