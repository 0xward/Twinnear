# Twinnear — Keputusan Desain dari Temuan QA (Agen 1b)

Tanggal: 2026-11-06 ~23:45 WIB · Penulis: Agen 1b (Keputusan Desain)
Dasar: `docs/qa-findings.md` (Agen 2, 2026-11-06 ~23:30 WIB) + `docs/research-notes.md` (Agen 1).
Status: **kontrak BELUM di-deploy** (terverifikasi QA via RPC: `twinnear.testnet`
saldo 4 NEAR, `code_hash` nol). Karena itu semua perubahan skema di bawah ini
masih bisa masuk SEBELUM deploy pertama — dan HARUS masuk sebelum deploy
pertama, karena migrasi struct setelah deploy jauh lebih mahal. Kumpulkan
H-02, H-03, M-03, H-06 (+ M-01 bila diputuskan) ke DALAM SATU build sebelum
deploy pertama (sesuai urutan perbaikan QA).

Dokumen ini adalah KEPUTUSAN, bukan implementasi. Implementasi kontrak =
Agen 3. Frontend yang sudah dikerjakan dari keputusan ini dicatat di bagian
akhir tiap temuan ("Sudah dikerjakan di frontend").

---

## 0. Keputusan bahasa UI — TETAP INGGRIS

**Keputusan: seluruh UI Twinnear tetap berbahasa Inggris.**

Alasan:
- Juri hackathon internasional (Illia Polosukhin, a16z, Electric Capital,
  Dragonfly, dll.) dan AI judges membaca repo + demo dalam bahasa Inggris.
  README, halaman demo, dan alur "buat invoice → bayar → release" harus
  bisa diikuti juri tanpa terjemahan.
- Produk ini menargetkan "a normal company could use tomorrow" (brief track
  Real-World Money) — pasarnya global, bukan Indonesia saja.
- Preferensi pengguna berbahasa Indonesia berlaku untuk PERCAKAPAN dengan
  Muse, bukan untuk produk yang didemo ke juri.

Catatan: bila setelah hackathon produk diarahkan ke pengguna Indonesia,
i18n (Indonesia/Inggris) adalah pekerjaan lanjutan yang sah — bukan
sekarang, bukan sebelum deadline 15 Nov 2026 06:59 WIB.

---

## 1. H-03 — Escrow tanpa deadline / sengketa / cancel

### Masalah (QA)
Setelah `pay_invoice`, hanya seller yang bisa `release`/`refund`, keduanya
tanpa batas waktu. Client tidak bisa meminta refund sendiri, tidak bisa
membuka sengketa, tidak ada kedaluwarsa. Invoice `Pending` juga tidak bisa
dibatalkan seller (salah ketik jumlah/klien = invoice sampah permanen).
Pertanyaan pertama juri: "apa yang terjadi bila freelancer menghilang?"

### Prinsip keputusan
1. **Dana client tidak boleh terkunci selamanya.** Harus selalu ada jalan
   keluar yang tidak bergantung pada itikad baik seller.
2. **Tanpa keeper eksternal.** Kontrak NEAR tidak bisa "bangun sendiri" —
   tidak ada cron on-chain. Karena itu TIDAK ADA refund otomatis: semua
   pemulihan dipicu oleh satu klik manusia (client/seller). Ini dicatat
   sebagai known limitation yang jujur di README, bukan disembunyikan.
3. **Minimal dan simetris.** Jangan membangun pengadilan/arbitrase. Modelnya
   dua pihak + satu tenggat: client bisa menahan release (sengketa), seller
   selalu bisa mengembalikan (refund), dan setelah tenggat client bisa
   menarik kembali dananya sendiri.

### Struct `Invoice` yang diusulkan (persis — untuk Agen 3)

```rust
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Invoice {
    pub id: u64,
    pub seller: AccountId,
    pub client: AccountId,
    /// Amount in yoctoNEAR (MVP). 1 NEAR = 10^24 yoctoNEAR.
    pub amount: U128,
    pub description: String,
    pub status: InvoiceStatus,
    /// True once escrowed funds were released to the seller.
    pub released: bool,
    pub created_at: u64,
    pub paid_at: Option<u64>,
    /// Reference for off-chain settlement (1Click deposit address or tx
    /// hash). `None` for plain NEAR escrow payments.
    pub external_ref: Option<String>,
    /// NEW — nanosecond block timestamp by which the seller must release
    /// (or refund). `None` = no deadline, chosen explicitly by the seller
    /// at creation (the pay page warns the client about this).
    pub due_date: Option<u64>,
    /// NEW — true while the client disputes a paid, unreleased invoice.
    /// While true, `release_invoice` is blocked.
    pub disputed: bool,
    /// NEW — dispute reason (max 200 bytes), `None` when undisputed.
    pub dispute_reason: Option<String>,
}
```

Status enum bertambah satu varian (untuk invoice Pending yang dibatalkan):

```rust
pub enum InvoiceStatus {
    Pending,
    Paid,
    Refunded,
    /// NEW — cancelled by the seller while still Pending (no funds moved).
    Cancelled,
}
```

### Fungsi baru (kontrak — Agen 3)

| Fungsi | Siapa | Syarat | Efek |
|---|---|---|---|
| `cancel_invoice(id)` | seller | `status == Pending` | `status = Cancelled`. Tidak ada dana bergerak. Menyelesaikan "invoice sampah" akibat salah ketik. |
| `open_dispute(id, reason)` | client | `status == Paid && !released && !disputed`; `reason` ≤ 200 byte | `disputed = true`, `dispute_reason = Some(reason)`. `release_invoice` diblokir selama sengketa. |
| `withdraw_dispute(id)` | client | `disputed == true` | `disputed = false`, `dispute_reason = None`. Release bisa jalan lagi (damai). |
| `claim_refund(id)` | client | `status == Paid && !released && due_date == Some(d) && now >= d` | `status = Refunded`, transfer ke client. **Ini jalan keluar utama bila seller menghilang.** |
| `release_invoice(id)` | seller | syarat lama + `!disputed` | Tidak berubah selain assert tambahan. |
| `refund_invoice(id)` | seller | syarat lama (Paid, belum release) | Tetap bisa dipanggil kapan pun, TERMASUK saat `disputed` — seller yang kooperatif selalu bisa mengembalikan dana. |

### Aturan `due_date`
- `create_invoice` / `create_invoice_meta` menerima parameter baru
  `due_days: Option<u32>` (jumlah hari sejak pembuatan). Kontrak menghitung
  `due_date = created_at + due_days * 86_400_000_000_000` (ns).
- Nilai yang diterima: `1..=90` hari, atau `None` = tanpa deadline.
  `Some(0)` dan `> 90` ditolak.
- **Default UI: 14 hari** (pilihan 7 / 14 / 30 di form; 14 terpilih).
  `None` hanya bila seller memilih eksplisit "No deadline", dan halaman
  bayar wajib menampilkan peringatan ke client bila invoice tanpa deadline.
- Invoice `Pending` yang melewati `due_date`: TIDAK ada aksi otomatis
  (tidak ada dana terkunci — belum dibayar). UI menampilkan badge
  "Overdue" dari `due_date` vs waktu sekarang (ini juga menutup item 14
  research-notes: tanggal jatuh tempo + badge overdue).

### Yang DIPUTUSKAN TIDAK dibuat
- **Refund otomatis oleh kontrak / keeper bot:** tidak mungkin tanpa
  infrastruktur off-chain yang selalu jalan; di luar scope hackathon.
  `claim_refund` satu klik oleh client adalah mekanisme yang jujur.
- **Arbitrase pihak ketiga / owner sebagai juri:** sentralisasi + scope
  membengkak; tidak ada sebelum deadline.
- **Denda keterlambatan (`late_fee`):** ditolak (research-notes sudah
  menolaknya juga) — cukup due date.

### Interaksi dengan temuan lain
- **H-02:** `claim_refund` WAJIB memakai pola callback yang sama dengan
  `release`/`refund` hasil perbaikan H-02 (jangan ulangi `.detach()` tanpa
  callback — transfer gagal tidak boleh menandai Refunded).
- **M-02:** `claim_refund` hanya untuk jalur escrow. Invoice external
  (`confirm_external_payment`) tidak punya escrow, jadi tidak ada yang
  bisa di-claim — UI harus membedakan keduanya (lihat M-03).

### Sudah dikerjakan di frontend (Agen 1b)
- Belum ada: semua kontrol di atas butuh field kontrak yang belum ada.
  Menambah tombol/tanggal jatuh tempo sekarang = UI mati. Lihat
  "Frontend follow-up" di bawah.

---

## 2. M-03 — Spend-guard hanya di create, tanpa cap kumulatif, dilewati jalur external

### Masalah (QA)
1. Invoice yang dibuat SEBELUM client memasang policy tetap bisa dibayar
   penuh — policy tidak berlaku surut dan `pay_invoice` tidak memeriksa
   ulang.
2. Policy hanya membatasi PER invoice: 100 invoice @ batas maksimum bisa
   dibayar semua — tidak ada cap total.
3. Jalur 1Click/external sepenuhnya melewati spend-guard.

### Keputusan 1 — Cek ulang policy SAAT BAYAR (bukan hanya saat create)
`pay_invoice` WAJIB memeriksa policy client yang BERLAKU SAAT INI:
- tolak bila `amount > max_amount` (bila `max_amount > 0`);
- tolak bila seller tidak ada di `allowed_sellers` (bila allowlist tidak kosong).

**Konsekuensi yang diterima secara sadar:** invoice yang dibuat saat masih
diizinkan bisa menjadi TIDAK TERBAYAR setelah client memasang/mengubah
policy. Itu FITUR, bukan bug — policy adalah rem darurat client atas
dananya sendiri. UI wajib menjelaskan ini di halaman Spend guard
(copy baru sudah ditulis — lihat "Sudah dikerjakan di frontend").

### Keputusan 2 — Cap kumulatif harian, ditegakkan saat BAYAR
Tambah cap total per hari kalender (UTC). Ditegakkan di `pay_invoice` —
BUKAN di create — karena saat create belum ada uang yang bergerak, dan
invoice yang tidak pernah dibayar tidak boleh menghabiskan kuota.

Struct `Policy` yang diusulkan (persis — untuk Agen 3):

```rust
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(crate = "near_sdk::serde")]
pub struct Policy {
    /// Max amount (yoctoNEAR) a single invoice may charge this account.
    /// 0 = no limit. (tidak berubah)
    pub max_amount: U128,
    /// Sellers allowed to charge this account. Empty = any seller allowed.
    /// (tidak berubah)
    pub allowed_sellers: Vec<AccountId>,
    /// NEW — total maksimum yang boleh dibayar via escrow per hari kalender
    /// (UTC). 0 = tanpa batas.
    pub max_total_per_day: U128,
    /// NEW — jumlah yang sudah dibayar via escrow pada `daily_spent_day`.
    /// Akuntansi internal; BUKAN pengaturan.
    pub daily_spent: U128,
    /// NEW — nomor hari (block_timestamp_ns / 86_400_000_000_000) yang
    /// dimiliki `daily_spent`.
    pub daily_spent_day: u64,
}
```

Logika di `pay_invoice` (Agen 3):
- `day = env::block_timestamp() / 86_400_000_000_000`.
- Bila `day != policy.daily_spent_day` → `daily_spent = 0`,
  `daily_spent_day = day` (reset saat hari berganti).
- Bila `max_total_per_day > 0` dan
  `daily_spent + amount > max_total_per_day` → tolak pembayaran.
- Bila lolos → `daily_spent += amount`, simpan policy.

**`set_policy` harus MEMPERTAHANKAN `daily_spent` / `daily_spent_day` yang
ada** (baca policy lama, bawa kedua field itu ke policy baru) — mengedit
pengaturan tidak boleh me-reset kuota harian yang sudah terpakai.

### Keputusan 3 — Jalur external TIDAK tercakup guard (dan itu dinyatakan jujur)
Kontrak tidak bisa memverifikasi uang yang tidak pernah menyentuh escrow,
jadi guard TIDAK BISA ditegakkan pada `confirm_external_payment`.
Yang diputuskan:
- (a) Label UI dibedakan: invoice external tampil
  **"Paid · external (unverified)"**, bukan "Paid · released"
  (mengadopsi perbaikan M-02 — Agen 3 di Dashboard/CSV + Agen 1b sudah
  menyiapkan copy-nya di halaman bayar).
- (b) Halaman Spend guard menampilkan peringatan eksplisit bahwa guard
  tidak mencakup pembayaran external / 1Click (sudah dikerjakan di
  frontend — lihat bawah).
- (c) Pembayaran external **TIDAK dihitung** ke `daily_spent`. Alasan:
  menghitung atestasi sepihak yang belum terverifikasi akan memberi
  seller cara meng-grief kuota harian client (klaim palsu → cap habis →
  pembayaran escrow sah tertolak).

### Sudah dikerjakan di frontend (Agen 1b)
- `frontend/src/pages/Policy.tsx`: kotak peringatan baru di bawah intro —
  guard saat ini hanya diperiksa saat invoice dibuat; invoice yang dibuat
  sebelum policy dipasang masih bisa dibayar; pembayaran external/1Click
  tidak dicakup guard. Copy ini menggambarkan perilaku KONTRAK SAAT INI.
- Setelah Agen 3 mengimplementasikan Keputusan 1–2, copy ini HARUS diubah
  menjadi: "Checked when the invoice is created AND again when you pay.
  A daily total cap also applies to escrow payments." + form mendapat
  field baru "Max total per day (NEAR)" (butuh `setPolicy` 3-argumen —
  `near.ts` milik Agen 3, JANGAN disentuh Agen 1b).

---

## 3. H-06 — Pembuatan invoice gratis membebani storage kontrak (spam)

### Masalah (QA)
Tiap invoice mengunci ±200–300 byte ≈ 0,002–0,003 NEAR dari saldo kontrak.
Pembuatan tidak memungut deposit storage, tidak ada batas per seller.
Ribuan invoice spam → saldo kontrak tergerus → `release`/`refund` gagal
(bergabung dengan H-02).

### Keputusan ekonomi
1. **Deposit storage 0,01 NEAR pada `create_invoice` langsung.**
   Agen 3: `create_invoice` menuntut `attached_deposit >= 0,01 NEAR`.
   - Angka: invoice ~200–300 byte ≈ 0,002–0,003 NEAR; 0,01 NEAR memberi
     headroom ~3–5x, termasuk field baru H-03 (`due_date`, `disputed`,
     `dispute_reason`).
   - Deposit **TIDAK dikembalikan** — ia membayar entri ledger permanen
     (invoice yang sudah Refunded/Cancelled pun tetap tersimpan sebagai
     riwayat bookkeeper). Ini harus tertulis jelas di UI sebelum submit.
   - Efek anti-spam: 1.000 invoice spam = 10 NEAR. Spam menjadi mahal,
     freelancer sah hampir tidak merasakan (0,01 NEAR ≈ sepersekian sen).
2. **Jalur meta (gasless) TIDAK kena deposit.** Seller tidak bisa attach
   deposit lewat pesan NEP-413 (yang membayar gas adalah relayer).
   Gantinya: relayer allowlist + rate-limit per seller (H-04, Agen 3)
   + cap kontrak di bawah ini.
3. **Cap kontrak: maks 50 invoice Pending (terbuka) per seller.**
   `create_invoice` / `create_invoice_meta` ditolak bila seller sudah
   punya 50 invoice berstatus Pending. Cap dihitung dari invoice TERBUKA
   saja — cap total akan menghukum seller aktif yang sah (riwayat
   tertutup tetap tersimpan; storage-nya sudah dibayar deposit).
4. **Akuntansi escrow (bagian dari H-06, untuk Agen 3):** kontrak melacak
   total dana escrow dan menolak pembuatan invoice baru bila
   `saldo tersedia − total escrow < cadangan minimum` — supaya spam
   storage tidak pernah bisa membuat `release`/`refund` gagal (H-02).

### UX (copy yang harus tampil setelah Agen 3 — JANGAN mendahului kontrak)
Form New Invoice wajib menampilkan sebelum submit:
> "Creating this invoice locks a 0.01 NEAR storage deposit — one-time,
> non-refundable; it pays for the ledger entry. Escrowed funds are
> separate: the client pays the invoice amount, and it returns to the
> client on refund."

### Yang DIPUTUSKAN TIDAK dibuat
- **Tetap gratis tanpa batas (status quo):** ditolak — rentan spam,
  mengancam H-02.
- **Deposit besar (0,1 NEAR):** ditolak — menghambat freelancer kecil
  dan membuat demo mahal (15 invoice demo = 1,5 NEAR).
- **Menghapus invoice lama untuk merebut storage:** ditolak — merusak
  audit trail bookkeeper (CSV/ledger adalah nilai jual produk).

### Anggaran demo (kaitannya dengan M-08)
0,01 NEAR × ~15 invoice demo = 0,15 NEAR — muat dalam sisa liquid
~0,5–0,7 NEAR setelah deploy (akun 4 NEAR, kode 326 KB ≈ 3,26 NEAR).
Tetap: top-up faucet dulu sebelum deploy (M-08).

### Sudah dikerjakan di frontend (Agen 1b)
- Belum ada: copy deposit di atas TIDAK BOLEH tampil sebelum kontrak
  benar-benar memungutnya (copy yang mendahului kontrak = kebohongan
  di depan juri). Lihat "Frontend follow-up".

---

## 4. Keputusan lain dari QA (L-09 / L-10)

- **"Clear rules" tanpa konfirmasi (L-09):** DIPUTUSKAN wajib konfirmasi.
  Satu klik tidak boleh menghapus seluruh proteksi spend-guard.
  Sudah diimplementasikan: `frontend/src/pages/Policy.tsx` — klik
  "Clear rules" kini memunculkan `window.confirm()` yang menjelaskan
  bahwa limit + allowlist akan dihapus; field baru dikosongkan bila
  pengguna setuju (penerapan on-chain tetap butuh "Save policy").
- **"500 characters" padahal byte (L-09):** pesan error kontrak
  (`lib.rs:113`) harus diganti Agen 3 menjadi
  `"description must be at most 500 bytes"`. Frontend sudah menampilkan
  penghitung byte live di form New Invoice (lihat bawah) — emoji dan
  karakter multi-byte dihitung dengan benar.
- **Kontras teks redup (L-10):** `--ink-faint` `#8a8272` (~3,5:1) →
  `#6b6355` (~5:1, di atas ambang WCAG AA 4,5:1 untuk teks kecil).
  Sudah diimplementasikan di `frontend/src/index.css`.
- **Bahasa UI:** tetap Inggris (bagian 0 di atas).

---

## 5. Frontend follow-up (setelah Agen 3 mengimplementasikan kontrak)

Checklist ini BUKAN dikerjakan Agen 1b sekarang — dikerjakan setelah
field/fungsi kontrak di atas ada:

1. **H-03 — New Invoice:** pemilih due date (7 / 14 / 30 hari, default
   14) + opsi "No deadline" dengan peringatan; kirim `due_days`.
2. **H-03 — Pay page:** tampilkan due date; badge "Overdue" bila lewat;
   tombol "Open dispute" (client, Paid & belum release) + "Withdraw
   dispute"; tombol "Claim refund" muncul untuk client setelah deadline;
   tombol "Cancel invoice" untuk seller saat Pending; timeline mendapat
   langkah Due / Dispute / Cancelled.
3. **H-03 — Invoices/Dashboard:** filter + stamp "Cancelled" dan
   "Disputed".
4. **M-03 — Policy page:** field "Max total per day (NEAR)"; ubah copy
   peringatan sesuai Keputusan 1–2 (guard dicek saat create DAN saat
   bayar); tampilkan "Spent today" dari policy.
5. **M-03 — Dashboard/CSV:** label "Paid · external (unverified)"
   untuk invoice external (butuh pembeda `external_ref` — sudah ada di
   struct; Agen 3 membedakan tampilannya).
6. **H-06 — New Invoice:** tampilkan biaya deposit storage 0,01 NEAR
   sebelum submit (copy di bagian 3); tampilkan sisa kuota invoice
   terbuka bila view tersedia.
7. **L-09 — Deploy page:** angka saldo hardcoded sudah diperbaiki
   Agen 1b (326 KB / ~3,26 NEAR / ~0,7 NEAR liquid); ganti dengan saldo
   live bila Agen 3 menambahkan view saldo (M-05).

---

## 6. Ringkas untuk Agen 3 (apa yang harus diubah di kontrak)

1. `Invoice`: + `due_date: Option<u64>`, `disputed: bool`,
   `dispute_reason: Option<String>`; `InvoiceStatus` + `Cancelled`.
2. `create_invoice` / `create_invoice_meta`: param `due_days: Option<u32>`
   (1–90, `None` = tanpa deadline); deposit storage 0,01 NEAR untuk
   `create_invoice`; tolak bila seller sudah punya 50 invoice Pending.
3. Fungsi baru: `cancel_invoice`, `open_dispute`, `withdraw_dispute`,
   `claim_refund` (pakai pola callback H-02, bukan `.detach()`).
4. `release_invoice`: assert `!disputed`.
5. `pay_invoice`: cek ulang policy saat ini (max per invoice + allowlist)
   + cap kumulatif harian (`max_total_per_day`, `daily_spent`,
   `daily_spent_day`); reset harian otomatis.
6. `Policy`: + `max_total_per_day`, `daily_spent`, `daily_spent_day`;
   `set_policy` mempertahankan `daily_spent`/`daily_spent_day`.
7. Pesan error deskripsi: "500 bytes" bukan "500 characters".
8. Lacak total escrow; tolak create bila saldo tersedia − escrow <
   cadangan minimum.
9. Semua di atas dalam SATU build sebelum deploy pertama.
