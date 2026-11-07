# Twinnear v2 — Build Spec (SHARED, mengikat agen kontrak + agen frontend)

Tanggal: Sabtu, 7 Nov 2026. Deadline submit hackathon: Minggu, 15 Nov 2026 06:59 WIB.
Status awal: kontrak v1 LIVE di `twinnear.testnet` (wasm SHA
`5c1c22243b9ce154d7f31da2d34185067208d2030647060a2869d1f6c6e09b1b`, 194.009 byte).
Ada 1 invoice live: #1 TW-2026-0001, seller `twinnear.testnet`, client
`0xward.testnet`, amount 50000000000000000000000 yoctoNEAR, description
"Design work, Framework, Testing", Pending, created_at 1794021148914561684,
due_date 1795230748914561684, paid_at null, external_ref null, disputed false.

Aturan keras (tidak boleh dilanggar):
- TANPA Groq / tanpa AI. Desain paper (putih kertas, serif, aksen tinta)
  TETAP identitas — polish "mewah" = tipografi, spacing, micro-interaction,
  PDF premium; BUKAN ganti identitas.
- JANGAN deploy kontrak. JANGAN sentuh/minta private key atau seed phrase.
  Deploy upgrade dilakukan pengguna sendiri via Termux.
- JANGAN pecahkan: fix `globalThis.Buffer` di `frontend/src/main.tsx`,
  langganan `onAccountChange` di `frontend/src/lib/near.ts`, HashRouter,
  setup Wallet Selector (Meteor + OKX).
- Semua 40 unit test lama harus tetap lolos; tambah test untuk yang baru.
- Jangan ubah struktur goal, jangan sentuh dompet/chain BSC.

---

## 1. KONTRAK v2 — API (mengikat kedua agen)

### 1.1 Tipe baru

```rust
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum Currency { Near, Usdc }   // JSON: "Near" | "Usdc"

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct InvoiceLineItem {
    pub description: String,      // max 200 byte
    pub quantity: u32,            // 1..=10000
    pub unit_price: U128,         // smallest unit mata uang invoice
}
```

### 1.2 Struct `Invoice` — field baru DITAMBAH DI AKHIR (setelah `dispute_reason`)

Urutan field lama TIDAK BOLEH berubah (Borsh: byte lama adalah prefix ketat):

```rust
pub currency: Currency,          // Near = yoctoNEAR; Usdc = micro-USDC (6 desimal)
pub items: Vec<InvoiceLineItem>, // kosong = invoice baris-tunggal (legacy)
pub tax_rate_bps: u32,           // 0..=10000 (10000 = 100%)
pub subtotal: U128,              // Σ qty*unit_price (atau = amount bila items kosong)
pub tax_amount: U128,            // subtotal * bps / 10000 (0 bila items kosong)
```

`amount` tetap TOTAL (subtotal + tax) dalam smallest unit mata uang invoice.

### 1.3 `create_invoice` — signature baru (JSON args bernama)

```rust
pub fn create_invoice(
    &mut self,
    client: AccountId,
    amount: U128,               // TOTAL; harus == subtotal + tax bila items non-kosong
    description: String,
    due_days: Option<u32>,
    currency: Currency,
    items: Vec<InvoiceLineItem>,
    tax_rate_bps: u32,
) -> u64
```

Aturan:
- `items.len() <= 20`; tiap item: description ≤ 200 byte, quantity 1..=10000,
  unit_price > 0. `tax_rate_bps <= 10000`.
- Bila `items` kosong: wajib `tax_rate_bps == 0`; subtotal = amount, tax = 0
  (perilaku legacy — semua test lama tetap valid dengan args baru ini).
- Bila `items` non-kosong: hitung subtotal (checked arithmetic, overflow =
  panic "line item total overflow"), tax = subtotal * bps / 10000 (integer
  division), total = subtotal + tax; assert `amount == total`
  ("amount must equal line-item total (subtotal + tax)").
- `currency == Usdc`: amount dalam micro-USDC. Spend-guard: cek allowlist
  TETAP berlaku; cek max_amount & daily cap DILEWATI untuk USDC (satuan
  tidak sebanding — dokumentasikan di komentar kode + catatan UI).
- Storage deposit 0,01 NEAR tetap berlaku (deposit NEAR untuk storage,
  tidak tergantung mata uang invoice).

### 1.4 `create_invoice_meta` — TIDAK BERUBAH

Signature lama dipertahankan apa adanya (single-line NEAR). Di dalamnya,
panggil `create_invoice_inner` dengan currency=Near, items=[], tax=0.
Pesan kanonik NEP-413 TIDAK BERUBAH — jangan sentuh `verify_meta_signature`,
`relayer.ts`, atau `server.mjs` untuk pesan ini. Konsekuensi UI: opsi gasless
hanya tampil untuk invoice NEAR baris-tunggal tanpa pajak; bila invoice
USDC / multi-baris / berpajak, sembunyikan checkbox gasless + beri penjelasan.

### 1.5 `pay_invoice` — tolak invoice USDC

```rust
// di awal pay_invoice, setelah load invoice:
assert!(invoice.currency == Currency::Near,
    "USDC invoices settle via 1Click, not escrow — seller confirms with confirm_external_payment");
```

Alasan: kontrak tidak memegang USDC; settlement USDC lewat 1Click langsung
ke seller lalu `confirm_external_payment` (sudah ada, tidak berubah).

### 1.6 `migrate` + `get_version`

```rust
/// Satu-satunya jalur upgrade struct. Owner only. Membaca state v1,
/// mengonversi tiap invoice (currency=Near, items=[], tax=0,
/// subtotal=amount, tax_amount=0), menulis state v2.
#[init(ignore_state)]
pub fn migrate() -> Self { ... }

/// Versi skema kontrak. v1 tidak punya method ini; v2 mengembalikan 2.
pub fn get_version(&self) -> u32 { 2 }
```

Desain migrasi (WAJIB dipatuhi):
- Definisikan `OldInvoice` (salinan persis struct Invoice v1, 13 field,
  urutan sama) dan `OldContract` (salinan persis struct Contract v1,
  urutan field sama, LookupMap dengan prefix SAMA: invoices b"i",
  policies b"p", relayer, meta_nonces b"m", pending_transfers b"m"→b"t",
  failed_transfers b"f", open_pending_count b"o").
  Perhatian: prefix di lib.rs saat ini: invoices b"i", policies b"p",
  meta_nonces b"m", pending_transfers b"t", failed_transfers b"f",
  open_pending_count b"o" — SALIN PERSIS, jangan ditebak.
- `migrate`: `let old: OldContract = env::state_read().expect(...)`;
  assert `predecessor == old.owner` ("only the owner can migrate");
  iterasi id 1..old.next_invoice_id, baca tiap OldInvoice, konversi,
  insert ke LookupMap invoices BARU (prefix b"i" sama); pindahkan
  semua map lain (policies, meta_nonces, pending_transfers,
  failed_transfers, open_pending_count) + field skalar apa adanya.
- Struct `Contract` v2: URUTAN FIELD SAMA PERSIS dengan v1, TIDAK ADA
  field top-level baru (tidak ada LookupMap baru). Ini membuat blob
  state top-level v1/v2 identik byte-nya — migrasi hanya menulis ulang
  nilai-nilai map "i".
- Test migrasi WAJIB (di `contract/src/lib.rs`, modul tests):
  1. Bangun state v1 di mock env (OldContract + satu invoice dengan
     DATA PERSIS invoice #1 live — lihat atas dokumen ini), tulis via
     `env::state_write`.
  2. Panggil `Contract::migrate()` sebagai owner.
  3. Assert: invoice #1 selamat dengan SEMUA field lama identik
     (amount, description, status Pending, due_date, created_at, dsb.)
     + field baru (currency Near, items [], tax 0, subtotal == amount,
     tax_amount 0); `get_owner` tetap twinnear.testnet;
     `get_invoice_count() == 1`; `get_version() == 2`; `create_invoice`
     baru (line items + USDC) jalan setelah migrasi.
  4. Assert: `migrate` oleh BUKAN owner panik; `migrate` kedua kali
     panik TANPA merusak state (invoice #1 tetap terbaca).
- Setelah migrasi, JANGAN PERNAH panggil `new` lagi saat redeploy.

### 1.7 Yang TIDAK berubah di kontrak

`confirm_external_payment`, `release/refund/claim_refund`, `cancel_invoice`,
`open/withdraw_dispute`, `set_policy`, `set_relayer`, `propose/accept_owner`,
`rescue_escrow`, semua view lama, semua konstanta H-06. `Policy` tidak berubah.

---

## 2. FRONTEND — scope per fitur

### F1 — Invoice USDC via 1Click
- `types.ts`: `Invoice` + `currency: "Near" | "Usdc"`, `items: LineItem[]`,
  `tax_rate_bps: number`, `subtotal: string`, `tax_amount: string`.
  `LineItem { description: string; quantity: number; unit_price: string }`.
- `near.ts`: `createInvoice(client, amount, description, dueDays, currency,
  items, taxRateBps)` — amount dalam smallest unit (NEAR: yocto via
  `parseNearAmount`; USDC: micro via `parseUsdcAmount` baru, maks 6 desimal).
  Tambah `parseUsdcAmount`, `formatUsdc(micro) -> "12.34"`, `getVersion()`.
- `intents.ts`: tambah `USDC_NEAR_ASSET =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"`.
  `quoteIntentSettlement` sudah menerima `destinationAsset` — pakai itu.
- NewInvoice: toggle mata uang NEAR/USDC + catatan jujur di bawahnya:
  "USDC invoices settle via 1Click to the seller (no escrow, no spend-guard
  amount cap). 1Click has no testnet — on testnet the flow is shown with the
  existing external-payment confirmation."
- PayInvoice: invoice USDC → panel 1Click jadi jalur utama (destination
  USDC_NEAR_ASSET, amountOut = invoice amount); tombol bayar escrow NEAR
  DISEMBUNYIKAN + penjelasan. Invoice NEAR → perilaku lama.
- Daftar/Dashboard/CSV: badge mata uang (NEAR/USDC), jumlah dalam satuan
  asli; CSV tambah kolom `currency`, `subtotal`, `tax_amount`, `items`.

### F2 — Line items + pajak + PDF
- NewInvoice: editor baris dinamis (tambah/hapus baris: deskripsi, qty,
  harga satuan); input pajak (%) ; pratinjau live subtotal/pajak/total
  (hitung di frontend dengan BigInt, sama dengan rumus kontrak).
- PDF: tambah dependensi `jspdf`; tombol "Download PDF" di halaman
  PayInvoice (dan aksi per-baris di Invoices). Layout premium gaya paper:
  kop brand + logo, ref TW-2026-0001, tanggal dibuat/jatuh tempo,
  seller/klien, tabel line items, subtotal/pajak/total, status, catatan
  estimasi fiat, footer. Bila `npm install jspdf` gagal (offline),
  fallback: print stylesheet (`@media print`) + tombol Print — laporkan
  bila fallback yang dipakai.
- CSV: jumlah presisi penuh (sudah ada `formatNearFull` — pakai itu;
  jangan ulangi L-06), tambah kolom currency/subtotal/tax/items/external_ref.

### F3 — Invoice berulang / retainer (frontend-only, localStorage)
- Halaman baru `/recurring` (nav "Retainers"). Key localStorage
  `twinnear.recurring.v1`.
- Template: nama, client, currency, items, tax_rate_bps, frekuensi
  (weekly/monthly/quarterly), tanggal berikutnya, aktif/nonaktif.
- Tombol "Generate due invoices": untuk tiap template aktif yang tanggalnya
  sudah lewat, buat invoice via `createInvoice` (satu tx per invoice,
  konfirmasi wallet per invoice — jelaskan di UI); majukan tanggal
  berikutnya sesuai frekuensi. Badge "Due" bila tanggal ≤ hari ini.
- Tidak ada cron/background — tulis itu jelas di halaman.

### F4 — Portal klien
- Halaman baru `/portal` (nav "Client portal"). Connect wallet → tampilkan
  HANYA invoice dengan client == akun yang connect, bahasa polos
  ("Awaiting your payment", "Paid — held in escrow", "Refunded",
  "Paid via external payment"), tombol Pay ke `/pay/:id`, tanpa jargon
  (sembunyikan "yocto"/"escrow" dari klien; "held securely" bila perlu).
- `/pay/:id` (sudah ada) dipoles copy-nya ke arah ramah-klien.

### F5 — Estimasi fiat USD
- `lib/fiat.ts` baru: harga NEAR/USD dari CoinGecko public API
  (`https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd`,
  tanpa API key), cache localStorage `twinnear.fiat-cache.v1` TTL 5 menit.
- Komponen kecil `FiatEstimate` ("≈ $X.XX (est.)") di: Dashboard total,
  baris Invoices, PayInvoice, pratinjau NewInvoice. USDC → ≈ $1.00
  (label "approx."). Bila fetch gagal → sembunyikan estimasi diam-diam
  (jangan tampilkan error). Tulis di dekatnya: "Estimate only — not the
  settlement rate."

### Banner + Deploy + DEPLOY.md (wajib)
- **ROOT CAUSE banner (terverifikasi 7 Nov 10:15 WIB via curl RPC):**
  respons mentah `view_code` mengembalikan field **`code_base64`**, BUKAN
  `code`. `isContractDeployed()` di `near.ts` membaca `res.code` (selalu
  undefined) → selalu false → banner selalu tampil. Perbaiki: baca
  `code_base64` (fallback ke `code` bila ada). Juga perbaiki komentar
  stale di `config.ts` ("Not yet deployed as of 2026-11-06").
- Halaman Deploy: banner peringatan jelas di atas form — "Browser deploy
  via Meteor is BLOCKED by Meteor (DeployContract blocked). Recommended:
  near-cli-rs from a computer or Termux." Form deploy tetap ada (untuk
  wallet lain / bila kebijakan berubah) tapi beri label yang jujur.
  Tambah jalur "Redeploy (upgrade)" di halaman: deploy wasm SAJA
  (tanpa init `new`), lalu jalankan `migrate` via CLI — JANGAN tawarkan
  init `new` untuk redeploy.
- `DEPLOY.md`: tulis ulang — Path A (browser) = TIDAK direkomendasikan /
  diblokir Meteor; Path B (CLI) = jalur yang benar, dengan sintaks
  0.31.1 yang benar: import pakai positional
  (`near account import-account using-private-key 'ed25519:...'
  twinnear.testnet network-config testnet save-to-legacy-keychain`),
  deploy `sign-with-legacy-keychain` (Termux/headless) /
  `sign-with-keychain` (desktop). Tambah seksi Termux (proot-distro
  Ubuntu + binary aarch64, SHA
  `13d3103aa850294e6b9a2ed7832eb2abbcdf91986935b7edee80c304cef502ac`)
  dan seksi REDEPLOY + MIGRATE dengan perintah lengkap (lihat §4).

### Polish "mewah" (dalam identitas paper)
- Skala tipografi + spacing yang lebih rapi, status pill yang konsisten,
  hover state tabel, focus-visible (a11y murah: `role="alert"` pada error,
  `aria-live` pada notice, `scope="col"` pada th tabel).
- JANGAN redesign total; JANGAN ganti warna/identitas; JANGAN mode gelap.
- Bersihkan copy stale ("scaffold/phase 1") yang masih ada.

### `EXPECTED_WASM_SHA256` (koordinasi)
- Agen frontend JANGAN menebak SHA. Nilai baru diisi koordinator setelah
  agen kontrak melaporkan SHA build v2. Sampai saat itu, biarkan nilai lama
  + catat di laporan bahwa SHA belum diperbarui.

---

## 3. VERIFIKASI (masing-masing agen)

- Agen kontrak: `cargo test` (semua lolos, sebut jumlah), `./build-optimized.sh`
  (catat ukuran + SHA-256 wasm baru; pastikan export `migrate` +
  `get_version` ada di wasm — cek via `wasm-opt` output / daftar export).
  JANGAN deploy. JANGAN kirim tx apa pun.
- Agen frontend: `npm run build` (tsc + vite) hijau; `npx tsc --noEmit`
  bila perlu. JANGAN ubah main.tsx Buffer fix / near.ts onAccountChange.
- Keduanya: tulis laporan akhir ringkas (file berubah, apa yang terverifikasi,
  apa yang BELUM terverifikasi + alasannya).

---

## 4. RUNBOOK REDEPLOY + MIGRATE (untuk pengguna, via Termux — disiapkan koordinator di laporan akhir)

```
# 1. Unduh wasm v2 (link + SHA dari koordinator), lalu di Termux Ubuntu:
near contract deploy twinnear.testnet use-file twinnear.wasm without-init-call network-config testnet sign-with-legacy-keychain send
#    (PERHATIAN: without-init-call TIDAK menerima prepaid-gas/attached-deposit —
#    langsung network-config. Terverifikasi melawan near-cli-rs 0.31.1 --help,
#    7 Nov 10:20 WIB.)
# 2. Migrasi state (owner only, satu tx):
near contract call-function as-transaction twinnear.testnet migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send
#    (Rantai ini terverifikasi: prepaid-gas → attached-deposit → sign-as →
#    network-config → sign-with-legacy-keychain.)
# 3. Verifikasi:
near contract call-function as-read-only twinnear.testnet get_version json-args '{}' network-config testnet now   # → 2
near contract call-function as-read-only twinnear.testnet get_invoice json-args '{"id": 1}' network-config testnet now   # → invoice #1 utuh
```

Perintah di atas BELUM terverifikasi sintaksnya melawan near-cli-rs
0.31.1 (koordinator/QA memverifikasi `without-init-call` + `migrate`
sebelum diserahkan ke pengguna).
