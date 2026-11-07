# Twinnear — Research Notes (Agen 1: Riset + Kreatif / UI-UX)

Ditulis 6 Nov 2026, fase 3. Proyek: Twinnear, submission NEAR Hackathon track
Real-World Money (deadline Minggu 15 Nov 2026 06:59 WIB). Tanpa AI di mana pun.

---

## 1. Apa yang dinilai juri hackathon (track Real-World Money)

Sumber: nearhackathon.com & near.org/blog "NEAR HACKATHON: Build Beyond
Boundaries" (hackathon 1–14 Nov 2026, judging 16–18 Nov; juri antara lain
Illia Polosukhin, Eddy Lazzarin a16z, Mert Mumtaz Helius, Avichal Garg
Electric Capital, Haseeb Qureshi Dragonfly — plus Claude Code & Codex sebagai
AI judges), dan rubrik hackathon umum (theinnovationmode.com, hackntx.com).

- **Real-World Money = "Bring the boring money onchain."** Brief resmi:
  payroll, invoicing, remittances, merchant payments, stablecoin rails —
  "something a normal company could use tomorrow." Kata kunci track:
  STABLECOINS · NEAR INTENTS · META TRANSACTIONS. Twinnear sudah tepat di
  tengah brief: invoicing + 1Click/Intents + meta-transaction (relayer).
- **Yang dijuri (pola umum, bobot kurang-lebih sama):** Technology (seberapa
  sulit/mengesankan teknisnya), Design (apakah UX dipikirkan — antarmuka
  rapi, mudah dipakai), Completion (apakah benar-benar jalan, bukan mock).
  Rubrik 9 kriteria yang lebih rinci menekankan: problem importance,
  alignment dengan tema, idea effectiveness (mekanisme problem→outcome harus
  terlihat di demo, bukan sekadar daftar fitur), feasibility, ease of
  development/operations (jarak demo→produksi), impact yang dikuantifikasi
  jujur, dan novelty yang sudah dicek terhadap kompetitor.
- **Instruksi eksplisit dari penyelenggara:** repo harus publik sebelum
  14 Nov 23:59 UTC; README harus bekerja untuk juri manusia DAN AI —
  jelaskan apa produknya, masalahnya, cara menjalankannya, dan beri juri
  langkah demo yang jelas dengan hasil yang diharapkan tiap langkah
  ("do X, see Y"). Sebutkan teknologi NEAR yang dipakai (Intents, meta-tx,
  Wallet Selector) agar terlihat bagaimana teknologi itu menggerakkan produk.
- **Implikasi untuk Twinnear:**
  - Demo harus bisa dijalankan juri dalam hitungan menit: kontrak sudah
    ter-deploy di testnet + faucet 2 NEAR + alur "buat invoice → salin link
    → bayar → release" yang tanpa hambatan. Halaman /deploy dan banner
    "contract not deployed" harus hilang sebelum submit.
  - README + halaman depan harus menjual masalah dulu (freelancer menunggu
    dibayar 28,7 hari rata-rata; Xero Small Business Insights), baru fitur.
  - "A normal company could use tomorrow" → polesan bookkeeper (nomor
    invoice, daftar klien, CSV, timeline status) justru BUKAN hiasan: itu
    bukti produk ini untuk bisnis sungguhan, bukan demo token.
  - Kejujuran soal mock dihargai: 1Click memang mainnet-only (tidak ada
    testnet Intents) — label itu jelas di UI, jangan disembunyikan.

## 2. UX invoicing / pembayaran (praktik terbaik)

Sumber: dev.to (IndieOps), xero.com, stringlabscreative.com, calendefy.com,
rajeshdhiman.medium.com.

- **Payment link adalah fitur dengan leverage tertinggi.** Invoice dengan
  link bayar langsung dibayar 60–70% lebih cepat; invoice yang dikirim
  sebagai email + link dibayar rata-rata 15 hari lebih cepat daripada
  lampiran PDF polos. Link harus mustahil dilewatkan: baris sendiri,
  tombol besar, bukan terkubur di paragraf.
- **Hierarki visual 10 detik:** klien harus menemukan pengirim, jumlah,
  dan cara bayar tanpa mencari. Jumlah rata kanan, serif besar untuk angka,
  nomor invoice + tanggal terbit di dekat header.
- **Satu invoice = satu nomor + satu tanggal jatuh tempo.** Standar:
  `Invoice-038-NamaKlien-BulanTahun`. Nomor yang konsisten membuat
  penagihan, pencarian email, dan pembukuan bisa dilacak. Twinnear
  sebelumnya hanya menampilkan `id` mentah dari kontrak.
- **QR code di dalam invoice** memangkas langkah bayar (scan → bayar),
  terutama untuk klien mobile. Praktik umum di invoicing digital modern.
- **Status harus berupa timeline, bukan sekadar label.** Klien dan seller
  sama-sama ingin tahu: dibuat kapan → dibayar kapan → dana dilepas kapan /
  di-refund kapan. Label "Pending" saja tidak menjawab "sudah sampai mana".
- **Follow-up terjadwal, bukan mengemis:** pengingat di hari kirim,
  H-1 jatuh tempo, +1 hari telat, +7, +14 — dengan teks yang sama setiap
  kali. Twinnear belum punya tanggal jatuh tempo (kontrak tidak menyimpan
  due date), jadi yang bisa dilakukan sekarang: tombol "salin teks
  pengingat" dengan nomor invoice + jumlah + link, siap tempel ke
  email/chat.
- **CSV untuk bookkeeper:** ekspor harus menyertakan nomor referensi,
  status, tanggal ISO, dan baris total — supaya bisa langsung masuk ke
  pembukuan tanpa olah ulang.
- **Mobile-first:** klien membuka link bayar dari ponsel. Tabel harus
  bisa di-scroll horizontal, tombol minimal 44px, dan halaman bayar
  harus bekerja dengan satu tangan.

## 3. Pola 1Click / Intents (NEAR Intents)

Sumber: docs.near-intents.org (Swap Types), openfort.io (resep 1Click),
deepwiki (Near Intents CLI client), upswap.io (intent vs bridge).

- **Model mental yang benar:** pengguna mendeklarasikan HASIL ("seller
  menerima tepat X wNEAR"), solver berkompetisi mengisi. Bukan bridge
  lock-and-mint: deposit di chain asal → solver membayar dulu di chain
  tujuan → settlement kemudian. Atomic: selesai penuh atau dana kembali
  ke `refundTo`.
- **Tipe swap 1Click:** `EXACT_INPUT` (jumlah kirim tetap), `EXACT_OUTPUT`
  (jumlah terima tetap — ini yang dipakai Twinnear: invoice punya jumlah
  pasti), `FLEX_INPUT`, `ANY_INPUT`. Selalu tampilkan `amountIn` vs
  `minAmountIn`: selisihnya adalah buffer slippage, BUKAN harga lebih
  buruk — sisanya di-refund. Ini penting dijelaskan di UI, kalau tidak
  pengguna mengira mereka membayar lebih.
- **Alur UX yang direkomendasikan (resep Openfort):** 1) Quote — dry-run
  quote yang live saat pengguna mengetik; 2) Deposit — dompet menandatangani
  SATU transfer ke deposit address (native atau ERC-20 `transfer`);
  3) Track — polling `/v0/status` sampai `SUCCESS` / `REFUNDED` /
  `FAILED`, dengan link explorer asal + tujuan.
- **Deposit di bawah `minAmountIn` → refund setelah deadline; di atas
  `amountIn` → swap jalan, kelebihan di-refund.** Deadline default
  ~30 menit — deposit harus konfirmasi SEBELUM deadline. UI harus
  menampilkan ini, bukan menyembunyikannya.
- **Tidak ada testnet Intents.** Semua operasi 1Click memakai dana
  mainnet sungguhan. Twinnear sudah benar memberi label mainnet-only;
  jangan pernah menawarkan "coba 1Click di testnet".
- **Biaya:** 1Click mengenakan fee ~0,2% (bisa di-waive dengan JWT
  partner). Untuk demo hackathon, fee kecil ini layak disebut di halaman
  bayar supaya juri tidak mengira jumlah yang diterima seller = jumlah
  yang dikirim klien.
- **Peluang (belum diimplementasi):** quote dry-run yang auto-refresh
  saat pengguna mengganti aset sumber; countdown deadline deposit;
  status settlement dengan link explorer kedua chain.

## 4. NEAR Wallet Selector — praktik UX

Sumber: near/wallet-selector (DeepWiki), fxis.ai, docs.walletbeacon.io
(best practices), slimebook (lvl1/wallets).

- **Satu tombol, satu label:** tombol koneksi harus berlabel
  "Connect Wallet", selalu terlihat di kanan atas header, dengan indikator
  status (titik hijau saat terhubung) dan alamat/nama akun yang terhubung.
  Klik saat terhubung → dropdown: Disconnect + Open in explorer.
- **Modal memilih dompet, bukan memaksa satu dompet.** Twinnear sudah
  benar: Meteor + OKX via Wallet Selector. Untuk demo, Meteor adalah
  pilihan utama di desktop (rekomendasi komunitas); OKX untuk mainnet/
  payout. Jangan menambah dompet hanya demi jumlah — tiap modul adalah
  permukaan error baru.
- **Izin koneksi standar ~0,25 NEAR** hanya allowance, bukan pembayaran;
  koneksi membuat function-call key on-chain (~0,00004 NEAR + storage),
  jadi akun tanpa NEAR sama sekali tidak bisa connect. Pesan error
  "connect gagal" yang ramah harus menyebut kemungkinan ini.
- **Jangan pernah menangani seed phrase / private key.** Semua signing
  di dalam dompet. Twinnear sudah mematuhi ini (DeployContract pun
  ditandatangani di Meteor).
- **Setelah connect, halaman harus langsung menunjukkan apa yang bisa
  dilakukan akun itu** (seller vs client per invoice). Twinnear sudah
  melakukan ini di /pay/:id — pertahankan, dan jangan tampilkan tombol
  aksi yang pasti gagal untuk peran yang salah.

## 5. Inspirasi desain paper / ledger

Sumber: devdojo.com (Northzone, Venice), styles.refero.design (Compound),
prototemplate.com (design canon), uiux.mrramdn.com (Verso).

- **Northzone:** serif transisional kontras tinggi untuk semua yang
  berbicara, monospace untuk semua label; hairline 1px sebagai pengganti
  container; tanpa shadow, tanpa radius; ritme dari unit 4px dan margin
  yang lapang. Pelajaran: hierarki dari ukuran + spasi, bukan dari warna.
- **Venice:** dua suara — serif tajam untuk display, grotesque netral
  13–14px untuk UI/meta. Satu tombol pill gelap per section, sisanya
  ghost. Pelajaran: tombol primer harus langka dan jelas.
- **Compound:** keheningan kromatik total — satu typeface, satu berat,
  palet nyaris akromatik, hierarki dari lompatan ukuran (14px → 60px).
  Pelajaran: aksen warna tunggal (hijau tinta Twinnear) harus dipakai
  hemat: hanya untuk aksi primer, link aktif, dan status "paid".
- **Verso (paling dekat dengan Twinnear):** kertas hangat, tinta hangat,
  satu warna aksen; serif untuk teks, hairline rules sebagai pengganti
  shadow; "structure comes from 1px hairlines and whitespace."
- **Aturan yang kami terapkan di Twinnear:**
  - Kertas `#fdfbf6`, tinta `#1c1a17`, satu aksen hijau gelap `#1f4d3a`.
  - Serif (Georgia) untuk angka, judul, dan nilai; sans untuk label UI;
    monospace untuk alamat akun, hash, dan referensi teknis.
  - Hairline `#e3ddd0` untuk pemisah; garis kuat `#c9c0ab` untuk header
    tabel; garis ganda 2px tinta di bawah masthead (seperti sampul buku kas).
  - Status sebagai "stempel" (stamp) — label uppercase kecil dengan
    border, seperti cap di buku kas: Pending (kuning), Paid (hijau),
    Refunded (merah bata).
  - Bayangan sangat lembut saja; tidak ada gradien, tidak ada warna
    kedua.

## 6. Ide penambah nilai (tanpa AI) — status implementasi

### Diimplementasikan di fase 3 (Agen 1)

1. **Penomoran invoice** — referensi tampil `TW-2026-0001` (tahun dari
   `created_at` + id 4 digit), di daftar, halaman bayar, dan CSV.
   Nomor on-chain tetap `id`; referensi hanya kosmetik.
2. **QR code link bayar** — di halaman bayar, QR (SVG-hitam di atas
   putih, sesuai gaya paper) + tombol salin link dengan umpan balik
   "Copied". QR memakai paket `qrcode` yang SUDAH ada di node_modules
   sebagai dependensi transitif `@near-wallet-selector/modal-ui`
   (lihat catatan di bawah).
3. **Timeline status invoice** — Dibuat → Dibayar → Dilepas /
   Di-refund, dengan tanggal tiap langkah, di halaman bayar.
4. **Teks pengingat siap salin** — "Invoice TW-… sebesar X Ⓝ, bayar di
   <link>" — satu klik salin, siap tempel ke email/chat.
5. **Daftar klien (client directory)** — di Dashboard: semua klien dari
   semua invoice (bukan hanya yang sudah bayar), dengan jumlah invoice,
   total dibayar, total tertunggak, dan invoice terakhir. Klik klien →
   daftar invoice terfilter klien itu.
6. **Saran klien di form invoice baru** — datalist dari klien yang
   pernah ditagih (view call, tanpa biaya), mengurangi salah ketik akun.
7. **Pratinjau invoice di form** — panel kecil yang menampilkan
   bagaimana invoice akan terlihat (klien, jumlah, deskripsi) sebelum
   dikirim.
8. **Statistik "Outstanding"** — total NEAR dari invoice Pending di
   Dashboard, plus daftar 5 invoice terbaru.
9. **Poles export CSV** — kolom `invoice_ref` dan `external_ref`,
   tanggal ISO, baris TOTAL di akhir (total NEAR semua baris).
10. **Kartu ringkasan spend-guard** — di /settings: status perlindungan
    (Aktif/Tanpa aturan), batas per invoice, jumlah seller di allowlist —
    sebagai kartu statistik, bukan sekadar definisi.
11. **Indikator langkah Deploy** — 1 Connect → 2 Pilih wasm → 3 Deploy →
    4 Verifikasi, dengan status tiap langkah dari state halaman.
12. **Logo + favicon proper** — mark SVG gaya ledger (lihat
    `frontend/public/logo.svg`): bingkai buku kas ber-hairline ganda,
    huruf T serif, dan garis-garis ledger; dipakai di masthead dan
    sebagai favicon.
13. **Responsif mobile + aksesibilitas** — tabel dalam scroll horizontal,
    nav bisa di-scroll di layar kecil, tombol ≥44px di mobile, focus
    ring yang terlihat, `select` memakai class CSS (bukan inline style),
    dan gaya print yang menyembunyikan nav/tombol.

### Diusulkan, BELUM diimplementasikan (untuk fase berikut / Agen 2–3)

14. **Tanggal jatuh tempo (due date) + pengingat telat.** Perlu
    perubahan KONTRAK (field `due_date` + mungkin `late_fee` tidak —
    cukup due date). Tanpa itu, "overdue" tidak bisa dihitung jujur.
    Setelah ada: badge OVERDUE, filter "Overdue", dan teks pengingat
    mencantumkan tanggal jatuh tempo.
15. **Line items / rincian tagihan.** Kontrak saat ini hanya punya satu
    `description` + satu `amount`. Invoice profesional punya beberapa
    baris (jasa, kuantitas, tarif, subtotal). Perlu perubahan kontrak
    (struct `LineItem`) + UI form dinamis. Dampak demo besar — juri
    "normal company" langsung paham.
16. **Pembayaran sebagian (partial payment) / uang muka (deposit).**
    Alur umum freelancer: 50% di muka, sisanya saat selesai. Perlu
    perubahan kontrak (status + `amount_paid` akumulatif).
17. **Dukungan stablecoin (USDC/USDT di NEAR) sebagai mata uang
    invoice.** Track Real-World Money secara eksplisit menyebut
    stablecoin. Perlu perubahan kontrak (NEP-141 `ft_transfer_call`
    / escrow multi-token) — pekerjaan besar, tapi ini pembeda terkuat
    untuk track ini.
18. **Quote 1Click live yang auto-refresh + countdown deadline
    deposit.** Hari ini quote hanya diminta manual per klik. Perlu
    debounce + polling status yang lebih kaya (link explorer asal &
    tujuan, status REFUNDED/FAILED yang jelas).
19. **Mode "klien" (client view) yang lebih ramah.** Hari ini halaman
    bayar sama untuk seller dan klien. Versi klien: tanpa jargon
    (sembunyikan "escrow", "1Click", "yocto"), hanya: siapa yang
    menagih, berapa, tombol bayar besar, dan "dibayar dengan apa".
    Cocok untuk demo juri yang berperan sebagai klien.
20. **Riwayat / audit trail on-chain per invoice.** Timeline hari ini
    hanya dari 3 field (`created_at`, `paid_at`, `released`). Jejak
    lengkap (siapa release, kapan refund, ref eksternal) butuh event
    log di kontrak + indexer/pemindai — di luar scope fase 3.
21. **Template deskripsi + mata uang tampilan (fiat estimate).**
    Template deskripsi cepat ("Design work — …") dan estimasi nilai
    fiat dari harga NEAR (CoinGecko, cache) — murni frontend, risiko
    rendah, nilai demo sedang.
22. **Mode gelap? TIDAK direkomendasikan.** Desain paper adalah identitas
    produk; mode gelap merusak metafora buku kas. Jangan dibuat.

## 7. Catatan teknis / hutang kecil

- **QR memakai `qrcode` transitif.** Paket `qrcode@1.5.4` ada di
  `node_modules` karena `@near-wallet-selector/modal-ui` memakainya,
  tapi BUKAN dependensi langsung di `frontend/package.json` (agen ini
  dilarang menyentuh package.json). Build saat ini lolos karena
  package-lock menguncinya. Sebelum submit, jalankan
  `npm install qrcode @types/qrcode` di frontend agar menjadi dependensi
  langsung yang eksplisit — satu perintah, tanpa perubahan kode
  (deklarasi lokal `src/qrcode.d.ts` bisa dihapus setelah itu).
- **Kontrak belum di-deploy** saat catatan ini ditulis; semua halaman
  masih menampilkan banner "Contract not deployed yet". Hapus kondisi
  itu dari demo begitu deploy terverifikasi.
- **HashRouter** dipakai (URL `#/pay/:id`); link bayar yang dibagikan
  sudah benar dalam format itu — jangan ganti ke BrowserRouter tanpa
  konfigurasi server.
- **Tidak ada perubahan kontrak/relayer** dalam pekerjaan ini; semua
  ide di atas yang butuh perubahan kontrak ditandai di bagian 6.
