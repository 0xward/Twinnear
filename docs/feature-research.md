# Twinnear — Riset: Upgradeability Kontrak & Kesenjangan Fitur (Agen 1)

Ditulis: Sabtu, 7 Nov 2026. Deadline submit: Minggu, 15 Nov 2026 06:59 WIB.
Sisa waktu: ~8 hari (jendela build realistis s.d. 13 Nov; 14 Nov untuk video + submit).
Konteks: pengguna menunda deploy karena mengira kontrak yang sudah di-deploy itu
permanen, dan menilai web Twinnear saat ini terlalu sederhana fungsinya.

---

## Bagian A — Apakah kontrak NEAR yang sudah di-deploy itu permanen?

### Jawaban singkat: TIDAK. Kontrak NEAR bisa di-upgrade/di-deploy ulang oleh pemilik akun, kapan saja, ke akun yang sama, tanpa kehilangan state.

Ketakutan "sekali deploy = permanen" berasal dari intuisi Ethereum (di sana
upgrade butuh pola proxy yang dirancang di muka). NEAR dirancang berbeda.

### A.1 Fakta dari NEAR Docs ("Updating Contracts", docs.near.org)

Sumber utama: https://docs.near.org/smart-contracts/release/lock
(diperbarui 2026-10-28; halaman yang sama juga memuat "Locking a contract
account"). Tutorial pendamping:
https://docs.near.org/tutorials/examples/update-contract-migrate-state.md

1. **Logic dan state dipisah.** Akun NEAR menyimpan kode kontrak (logic)
   terpisah dari storage (state). Mengganti kode tidak menyentuh state.
2. **Dua cara upgrade:**
   - **Lewat tools** (NEAR CLI / API): deploy ulang wasm baru ke akun yang
     sama, asal memegang full-access key akun itu. Sesederhana
     `near deploy` lagi dengan file wasm baru.
   - **Programmatic:** kontrak mengimplementasikan method yang menerima
     wasm baru dan men-deploy-nya ke dirinya sendiri (Twinnear TIDAK punya
     method ini — sengaja, lihat A.4).
3. **State tetap ada setelah redeploy.** Menambah method baru atau mengubah
   logika method yang ada = **tidak ada masalah**. Yang bermasalah hanya
   bila struktur data yang tersimpan diubah/dihapus → error
   `Cannot deserialize the contract state`. Pilihannya saat itu: (a) pakai
   akun lain, (b) rollback ke kode lama, atau (c) tambah method `migrate`.
4. **Method `migrate`.** Method init khusus `#[init(ignore_state)]` yang
   membaca state lama, mentransformasi ke skema baru, dan menulisnya
   kembali. Pola lanjutannya: **state versioning** — bungkus state dalam
   enum yang tiap variannya mewakili satu versi skema, sehingga versi lama
   dan baru bisa hidup berdampingan.
5. **Kapan kontrak menjadi benar-benar tidak bisa diubah?** Hanya bila
   **semua full-access key dihapus dari akun kontrak** ("locking"). Setelah
   kunci dihapus, tidak ada yang bisa menandatangani transaksi atas nama
   akun itu — tidak bisa deploy kode baru, tidak bisa memindahkan saldo.
   Pengecualian: kontrak yang terkunci masih bisa upgrade DIRINYA SENDIRI
   bila kodenya mengekspos method programmatic update; Twinnear tidak
   punya method itu, jadi penghapusan kunci = immutable permanen. Tidak
   ada rencana menghapus kunci. (Catatan: ini tidak berlaku untuk global
   contract by account ID — Twinnear tidak memakai global contract.)
6. **Biaya redeploy = selisih storage.** Storage staking 1 NEAR per
   ~100 KB kode. Wasm baru yang ukurannya mirip = hampir tanpa biaya
   tambahan; wasm lebih besar = bayar selisihnya; wasm lebih kecil =
   sebagian stake kembali bebas (perkiraan, bukan kutipan docs).
7. **Alamat akun TIDAK berubah.** Redeploy ke `twinnear.testnet` tetap
   `twinnear.testnet` — link demo, konfigurasi frontend, dan README tidak
   perlu diubah saat kode di-upgrade.

### A.2 Yang aman vs yang butuh migrasi (aturan praktis, konsisten dengan docs + mekanisme Borsh)

| Perubahan | Aman tanpa migrasi? | Catatan |
| --- | --- | --- |
| Tambah method baru | ✅ Ya | State tidak berubah |
| Ubah logika method yang ada | ✅ Ya | Selama skema state sama |
| Tambah varian enum di AKHIR `InvoiceStatus` | ✅ Ya | Diskriminan Borsh lama tetap valid |
| Tambah field ke struct `Invoice` / `Policy` | ⚠️ Tidak | Invoice/policy lama gagal di-deserialize saat dibaca |
| Tambah/hapus field di struct `Contract` (top-level) | ⚠️ Tidak | Seluruh state gagal di-deserialize |
| Tambah `LookupMap` baru di `Contract` | ⚠️ Tidak | Itu field baru di struct top-level |
| Simpan data baru di map TERPISAH (prefix baru, struct lama utuh) | ✅ Ya | Trik standar: jangan sentuh struct lama |
| Ubah tipe field / hapus field | ⚠️ Tidak | Butuh `migrate` atau akun baru |

Cara menguji sebelum percaya: deploy versi lama ke akun test, buat
beberapa invoice, lalu redeploy versi baru ke akun yang sama dan baca
invoice lama. Testnet gratis — tim bisa membuktikannya sendiri.

### A.3 Spesifik untuk kontrak Twinnear saat ini (dibaca dari `contract/src/lib.rs`)

- **Belum ada method `migrate`.** Jadi hari ini, upgrade yang mengubah
  struct (`Invoice`, `Policy`, atau `Contract`) akan gagal dengan
  `Cannot deserialize the contract state`. Solusinya ada tiga: (a) desain
  fitur baru agar TIDAK mengubah struct lama (pakai map terpisah / tambah
  method saja), (b) tambahkan method `migrate` SEBELUM upgrade yang
  butuh itu, atau (c) deploy ke akun baru (kehilangan riwayat + escrow —
  jangan).
- **`new` (init) hanya bisa jalan sekali.** `new` memakai `#[init]` dan
  menegaskan `predecessor == current_account` (deploy + init atomik,
  anti front-running owner — temuan H-05). Saat REDEPLOY, **jangan panggil
  `new` lagi** — cukup deploy wasm-nya saja. (Tugas Agen 3: pastikan
  DEPLOY.md / halaman Deploy punya jalur "redeploy tanpa init".)
- **State saat ini masih KOSONG.** Kontrak belum pernah di-deploy; tidak
  ada satu invoice pun di chain. Artinya: **saat ini perubahan skema apa
  pun GRATIS** — tidak ada state lama yang bisa rusak. Ini jendela yang
  tidak akan kembali setelah deploy pertama + invoice pertama.
- **Escrow aman saat redeploy.** Dana escrow adalah saldo akun kontrak,
  bukan bagian dari kode. Redeploy tidak memindahkan / menghapus saldo.
  Yang harus dijaga: jangan deploy kode yang merusak pembacaan
  `total_escrowed` / `pending_transfers` sebelum semua escrow selesai.

### A.4 Rekomendasi waktu deploy

**Keputusan: deploy sekarang itu AMAN, tapi urutan paling cerdas adalah:
bekukan dulu 3–5 fitur prioritas (Bagian B.6) → implementasikan perubahan
kontrak yang mereka butuhkan SELAGI skema masih gratis → deploy → iterasi
frontend setelah deploy.**

Alasan:

1. **Menunda deploy TIDAK melindungi apa pun.** Redeploy selalu bisa.
   Yang dilindungi oleh "tunggu fitur selesai" hanyalah menghindari SATU
   langkah migrasi — dan itu hanya relevan bila fiturnya mengubah struct.
   Fitur yang hanya frontend (mayoritas) tidak pernah butuh redeploy.
2. **Tapi menambah fitur DULU juga benar — bila fiturnya butuh ubah
   struct.** Sekali ada invoice nyata di chain, tiap perubahan struct
   butuh kerja migrasi. Jadi urutan optimal: putuskan fitur → ubah
   kontrak (gratis) → deploy. Bukan: deploy → ubah kontrak → migrasi.
3. **Deploy lebih awal = jendela uji lebih panjang.** Yang paling
   berisiko kehabisan waktu bukan redeploy, melainkan: click-through
   browser sungguhan, tanda tangan Meteor asli untuk meta-tx, uji
   freelancer nyata, video demo, dan submit. Semua itu butuh kontrak
   SUDAH live. Target: **deploy 10–11 Nov**, menyisakan 12–14 Nov untuk
   uji + video + submit.
4. **Testnet bukan mainnet.** Tidak ada dana sungguhan, tidak ada pengguna
   sungguhan. "Permanen" tidak berlaku di sini — kalaupun deploy pertama
   bermasalah, akunnya bisa di-redeploy atau diganti.
5. **Satu hal yang sebaiknya ditambahkan ke kontrak SEBELUM deploy
   pertama:** method `migrate` (stub `#[init(ignore_state)]`) + pola
   state versioning bila ada waktu. Biayanya kecil (satu method +
   beberapa test), manfaatnya: semua upgrade struct di masa depan jadi
   punya jalur resmi. Alternatif murahnya: disiplin "jangan ubah struct
   lama, pakai map terpisah" — cukup untuk sisa hackathon.

**Kesimpulan untuk pengguna:** rasa takutnya bisa diluruskan — deploy
bukan vonis permanen. Yang benar-benar perlu diputuskan DULU hanyalah
daftar fitur yang butuh ubah struktur kontrak, karena itu satu-satunya
yang lebih murah dikerjakan sebelum deploy pertama.

---

## Bagian B — Kesenjangan fitur Twinnear

### B.1 Yang sudah ada (ringkas, per 7 Nov 2026)

Kontrak: buat/bayar/release/refund invoice, escrow, due date (1–90 hari),
sengketa + claim refund + cancel, spend-guard (max/invoice, allowlist,
cap harian — dicek saat create DAN saat bayar), meta-tx gasless
(relayer + verifikasi NEP-413 on-chain), `confirm_external_payment`
untuk settlement 1Click, rescue escrow, owner 2-langkah.
Frontend: Dashboard + Ledger, daftar invoice, buat invoice, halaman
bayar (QR, timeline status, panel 1Click), export CSV, daftar klien,
saran klien, pratinjau invoice, penomoran `TW-2026-0001`, halaman Spend
Guard, halaman Deploy, logo + desain paper, responsif mobile.

### B.2 Ekspektasi track Real-World Money

Brief resmi (nearhackathon.com, "Bring the boring money onchain"):
payroll, invoicing, remittances, merchant payments, stablecoin rails —
"something a normal company could use tomorrow." Tag track: STABLECOINS ·
NEAR INTENTS · META TRANSACTIONS. Twinnear sudah menutup invoicing +
Intents + meta-tx. **Dua lubang besar terhadap brief: (1) tidak ada
stablecoin — semua invoice berdenominasi NEAR; (2) tidak ada payroll /
remittance / merchant** — hanya invoicing satu lawan satu.

### B.3 Kompetitor langsung: Request Finance

Request Finance adalah aplikasi invoicing crypto yang sudah berjalan
(12+ chain termasuk NEAR, 140+ mata uang, dipakai 1.700+ perusahaan —
termasuk tim finance NEAR Protocol sendiri, dikutip di situs mereka).
Fiturnya: invoice berdenominasi fiat (USD/EUR/dll.) dibayar dengan
crypto/stablecoin, batch payment, 0,1% fee (maks $2). Diferensiasi
Twinnear yang masih valid: escrow on-chain + spend-guard + gasless
tanpa akun/signup + settlement Intents lintas chain + tanpa fee
platform. **Tapi dari sudut pandang juri, "invoice crypto" saja bukan
lagi baru — yang harus dibuktikan adalah escrow + guard + gasless
benar-benar jalan, dan satu alur yang Request tidak punya: invoice
USDC yang dibayar dari chain mana pun.**

Di daftar submission publik hackathon yang terlihat saat riset ini, belum
ada proyek invoicing lain yang tampil (yang terlihat: Allowance, dan
near-thesis di track Investment Thesis). Kompetitor se-track kemungkinan
muncul di hari terakhir — bukan alasan untuk santai, tapi bukan ancaman
yang terkonfirmasi.

### B.4 Fitur standar aplikasi invoicing nyata (FreshBooks / Wave / Square / Zoho / Stripe Invoicing)

Yang dianggap "normal" oleh perusahaan sungguhan: invoice berulang
(retainer), pembayaran sebagian / uang muka, line items + pajak, PDF +
kwitansi, pengingat jatuh tempo + denda telat, portal klien, multi-mata
uang, batch payment, manajemen klien + riwayat, estimasi nilai fiat,
template. Twinnear saat ini punya: manajemen klien dasar, CSV, due
date, sengketa. **Yang paling terasa absen bagi juri yang berperan
sebagai "perusahaan normal": invoice berulang, line items, PDF, dan
denominasi USD/stablecoin.**

### B.5 Daftar fitur tambahan berperingkat (dampak vs usaha)

Effort = perkiraan jam kerja agen (kontrak + frontend + test). "Butuh
ubah kontrak" = perlu redeploy; "ubah struct" = hanya gratis sebelum
deploy pertama. Realistis = bisa selesai + teruji sebelum 13 Nov.

| # | Fitur | Dampak | Usaha | Butuh ubah kontrak? | Realistis ≤13 Nov? |
| --- | --- | --- | --- | --- | --- |
| 1 | **Invoice berdenominasi USDC (via 1Click)** — invoice dalam USD/USDC, klien bayar dari chain mana pun, seller terima USDC di NEAR | ★★★★★ (lubang terbesar vs brief track: STABLECOINS) | Sedang (~6–10 jam): field `currency` di struct Invoice + UI pilih mata uang + quote 1Click saat bayar | Ya, tambah field struct (gratis pra-deploy) | ✅ Ya — tanpa escrow USDC |
| 2 | **Invoice berulang / retainer** — "ulang tiap bulan", auto-buat invoice berikutnya | ★★★★ (retainer = pendapatan inti freelancer; bukti "perusahaan normal") | Rendah–Sedang (~4–6 jam): murni frontend + penyimpanan jadwal; tanpa cron on-chain | Tidak | ✅ Ya |
| 3 | **Line items + pajak + PDF** — beberapa baris jasa (qty × tarif), field pajak, unduh PDF/kwitansi | ★★★★ (invoice terlihat profesional; juri langsung paham) | Sedang (~6–8 jam): tambah `items` ke struct Invoice + form dinamis + PDF/print | Ya, tambah field struct (gratis pra-deploy) | ✅ Ya |
| 4 | **Estimasi nilai fiat (USD) di semua jumlah** — harga NEAR live (CoinGecko, cache) | ★★★ (demo jadi dimengerti juri: "$50" bukan "0,5 NEAR") | Rendah (~2–3 jam): murni frontend | Tidak | ✅ Ya |
| 5 | **Portal klien** — klien connect wallet, lihat semua invoice-nya + kwitansi, tanpa jargon (sembunyikan "escrow/yocto") | ★★★★ (perspektif pembayar = separuh cerita) | Rendah–Sedang (~4–6 jam): filter `list_invoices` per klien + halaman ringkas | Tidak (filter di frontend; opsional view method baru) | ✅ Ya |
| 6 | **Batch pay / payroll-lite** — bayar beberapa invoice sekaligus (satu klik, loop transaksi) | ★★★★ (menyentuh kata "payroll" di brief track) | Sedang (~5–7 jam): UI pilih banyak + loop; tanpa ubah kontrak | Tidak | ✅ Ya (versi frontend) |
| 7 | **Pembayaran sebagian / uang muka 50%** — bayar sebagian, sisa saat selesai | ★★★★ (alur freelancer paling umum) | Sedang–Tinggi (~8–12 jam): field `paid_amount` + varian status baru (append enum = aman) + UI | Ya, ubah struct (gratis pra-deploy) | ⚠️ Borderline — hanya bila digabung dengan #1/#3 |
| 8 | **Pengingat jatuh tempo + badge OVERDUE** — daftar telat, teks pengingat siap salin (sudah ada) | ★★★ (due date sudah ada di kontrak — tinggal tampilkan) | Rendah (~2–3 jam): murni frontend | Tidak | ✅ Ya |
| 9 | **Profil bisnis seller** — nama bisnis, logo, alamat di invoice | ★★★ (profesionalisme) | Rendah (~3–4 jam): localStorage / profil on-chain ringan | Tidak (v1 localStorage) | ✅ Ya |
| 10 | **Denda telat (late fee)** | ★★ (kecil untuk demo) | Sedang (kontrak: hitung fee pasca-due) | Ya | ❌ Tunda |
| 11 | **Permintaan refund oleh klien** (seller menyetujui) | ★★ (sudah ada claim-refund + sengketa) | Sedang | Ya | ❌ Tunda — alur yang ada cukup |
| 12 | **Escrow USDC penuh (NEP-141 `ft_transfer_call`)** — USDC dikunci di kontrak seperti NEAR | ★★★★★ (versi "sempurna" dari #1) | Tinggi (~15–25 jam + risiko: callback FT, whitelist token, test) | Ya, besar | ❌ Tidak realistis ≤13 Nov — roadmap pasca-hackathon |
| 13 | **Pengingat email / notifikasi push** | ★★★ (perusahaan normal mengandalkannya) | Tinggi (butuh layanan off-chain) | Tidak | ❌ Tidak realistis — tanpa backend email |
| 14 | **Audit trail on-chain lengkap per invoice** | ★★ (bagus, bukan penentu) | Tinggi (event log + indexer) | Ya | ❌ Tunda |

### B.6 Rekomendasi: 5 fitur prioritas sebelum deploy

Dipilih karena: menutup lubang terbesar vs brief track + membuat produk
terasa seperti perusahaan normal, dengan total usaha yang masih muat
sebelum 13 Nov. **Ketiganya yang butuh ubah struct (#1, #3) harus
dikerjakan DULU, dalam satu redeploy-pra-deploy yang sama.**

1. **#1 Invoice USDC via 1Click (denominasi stablecoin, tanpa escrow
   USDC).** Satu-satunya fitur yang menjawab tag STABLECOINS. Scope
   jujur: invoice berdenominasi USDC; klien bayar dari chain mana pun
   lewat 1Click; seller terima USDC di NEAR; invoice ditutup via
   `confirm_external_payment` (tetap dilabeli "external (unverified)").
   Jangan klaim escrow USDC — itu #12.
2. **#3 Line items + pajak + PDF.** Membuat invoice terlihat seperti
   invoice sungguhan di mata juri. PDF bisa memakai gaya print yang
   sudah ada + jsPDF; pajak = satu field persen + hitung otomatis.
3. **#2 Invoice berulang (retainer).** Tanpa ubah kontrak. Paling murah
   per dampaknya; cerita "perusahaan normal" langsung naik.
4. **#5 Portal klien.** Murah, dan demo jadi dua sisi: juri bisa
   berperan sebagai klien yang membayar — momen demo terkuat kedua
   setelah escrow.
5. **#4 Estimasi fiat (USD).** Paling murah; membuat semua angka di
   demo bisa dipahami juri non-crypto dalam sekejap.

Opsional bila waktu tersisa: #6 batch pay (payroll-lite) dan #8 badge
OVERDUE — keduanya frontend-only, bisa ditambah kapan pun bahkan
setelah deploy.

### B.7 Yang sengaja TIDAK dikerjakan sebelum deadline

- **#12 Escrow USDC penuh (NEP-141):** paling diminta secara teori,
  paling berisiko secara praktik. Ditunda ke roadmap pasca-hackathon;
  #1 sudah memberi cerita stablecoin yang jujur.
- **#10 denda telat, #11 permintaan refund, #13 email, #14 audit
  trail:** dampak kecil atau butuh infrastruktur yang tidak ada.
- **Mode gelap:** tetap tidak — desain paper adalah identitas produk.

---

## Ringkasan eksekutif

1. **Deploy kontrak TIDAK permanen.** Pemilik akun (pemegang
   full-access key `twinnear.testnet`) bisa redeploy wasm baru ke akun
   yang sama kapan saja; state dan escrow tetap ada; alamat akun tidak
   berubah. Kontrak hanya menjadi immutable bila semua full-access key
   dihapus — tidak ada rencana itu.
2. **Satu-satunya yang lebih murah sebelum deploy pertama adalah
   perubahan struktur data kontrak** (tambah field ke `Invoice` /
   `Policy` / `Contract`). Setelah ada invoice nyata, perubahan itu
   butuh method `migrate` (yang belum ada) atau trik map terpisah.
3. **Urutan yang disarankan:** bekukan 5 fitur prioritas → implementasi
   (termasuk perubahan struct #1 + #3 + stub `migrate`) → **deploy
   10–11 Nov** → iterasi frontend + click-through + uji freelancer +
   video 12–14 Nov → submit sebelum 15 Nov 06:59 WIB.
4. **Fitur prioritas:** (1) invoice USDC via 1Click, (2) invoice
   berulang, (3) line items + pajak + PDF, (4) estimasi fiat USD,
   (5) portal klien. Opsional: batch pay, badge OVERDUE.

## Sumber

- NEAR Docs, "Updating Contracts" (termasuk "Locking a contract
  account"), diperbarui 2026-10-28:
  https://docs.near.org/smart-contracts/release/lock
- NEAR Docs, "Self Upgrade & State Migration" (tutorial + contoh
  `migrate`, state versioning, self-update):
  https://docs.near.org/tutorials/examples/update-contract-migrate-state.md
- NEAR Hackathon, track 08 Real-World Money:
  https://nearhackathon.com/#apply
- NEAR blog, "NEAR HACKATHON: Build Beyond Boundaries":
  https://www.near.org/blog/near-hackathon-build-beyond-boundaries
- Request Finance (kompetitor invoicing crypto, berjalan di NEAR):
  https://www.requestfinance.com/industries/saas dan
  https://www.onchainfinanceinstitute.com/articles/preparing-crypto-invoices-using-request-finance
- Praktik invoicing freelancer (FreshBooks/Wave/Square/Zoho):
  http://sonary.com/online-invoicing/,
  https://taskip.net/freelance-invoicing-software/,
  https://www.billclap.com/blog/recurring-invoicing-for-freelancers-how-to-stop-chasing-payments
- Riset internal sebelumnya: `docs/research-notes.md` (Agen 1, 6 Nov
  2026), `docs/qa-findings.md`, `contract/src/lib.rs` (dibaca 7 Nov 2026).
