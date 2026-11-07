# Studi Banding Kompetitif — Twinnear, Malam 7 November 2026

**Tujuan:** jadi nomor 1 di track 08 Real-World Money, NEAR Hackathon (deadline **Minggu 15 Nov 2026 06:59 WIB**).
**Tanggal riset:** 7 November 2026 malam (WIB). Semua klaim dicek dari sumber publik segar malam ini — GitHub API, repo mentah, halaman hackathon, RPC testnet, dan file video pesaing yang diunduh + di-probe ffprobe + diinspeksi frame-nya.
**Status Twinnear saat riset:** kontrak v3 live, relayer gasless terbukti end-to-end, 51 unit test, invoice #4 gasless sudah on-chain.

> **Koreksi atas studi lama (7 Nov pagi):** studi lama hanya membaca halaman 1 `/api/projects` (8 proyek) dan menyimpulkan "0 di Real-World Money". **Itu salah.** API memakai paginasi 8/halaman; total sebenarnya **245 proyek** dan **50 di antaranya bertag `realworld`**. Studi ini membaca semua 31 halaman.

---

## 1. Ringkasan eksekutif

**Data segar malam ini:** `/api/applications` = **244 aplikasi** (naik dari 223 pagi), `/api/projects` = **245 proyek** (31 halaman × 8). Tag terbanyak: security 131, agents 123, **realworld 50**, business 44, open 42, privacy 39, defi 38, thesis 23, swarms 18, nfts 17, social 12, games 11, memecoins 5. Banyak proyek menandai banyak track sekaligus (mis. ZEDEC 9 track) — tag saja bukan bukti fokus utama.

**Ancaman terbesar di track 08: Settl** (`ZSP111/settl`). Satu-satunya pesaing invoice yang **sudah live di mainnet** (`settl-billonaire.near`) dengan receipt pembayaran nyata, kontrak Rust + gasless relay + sponsored storage, dan 51 unit test + 4 e2e — jumlah test sama persis dengan Twinnear. Keunggulan Twinnear atas Settl: retainer, portal klien, PDF/CSV, spend-guard, dispute, estimasi fiat, validasi live akun, dan gasless NEP-413 yang terbukti end-to-end (Settl tidak menunjukkan bukti gasless live yang sama). Kelemahan Twinnear vs Settl: belum ada mainnet sama sekali, dan belum ada video.

**Pesaing invoice lain di track 08:** Invoice Link (tanpa kontrak sama sekali — invoice tersimpan server-side; tapi punya pipeline rekam video + 30 test + e2e Playwright), SpecLock (mekanisme paling orisinal: invoice = sub-akun keyless + verifier checklist; live di Vercel; tanpa video), Settle (tanpa kontrak, tanpa hosting, tanpa video — hanya dokumentasi kuat), ProofPay (tipis, baru 6 Nov).

**Peringkat jujur Twinnear saat ini (track 08):**

| Kriteria | Peringkat | Keterangan |
|---|---|---|
| Kelengkapan produk live | **#1–#2** | Setara/unggul vs Settl soal fitur; Settl unggul soal mainnet |
| Bukti gasless end-to-end | **#1** | Satu-satunya invoice gasless dengan tx nyata terverifikasi (invoice #4, tx `2iMVmF156UnK3WR1nHJxnwgCYSisy8585NNGQtBKnXz4`) |
| Rigor pengujian | **#2–#3** | 51 unit test = Settl; jauh di bawah Veto (lintas track: 94 JS + 31 Rust + 37 conformance + 29 adversarial + 1000 aksi acak) |
| Video demo | **TERAKHIR** | Twinnear satu-satunya kandidat serius tanpa video; semua pesaing kuat sudah punya |
| Dokumentasi & kejujuran | **#1–#2** | `verify-in-2-minutes.md` + pengakuan celah USDC di About/FAQ; tapi README sudah basi (masih tulis v2 / 50 test) |
| Orisinalitas | **Tengah** | Invoice adalah ide paling ramai di track ini (5+ proyek); diferensiasi Twinnear = kombinasi gasless + escrow + retainer + portal + PDF/CSV + spend-guard dalam satu produk |

**Vonis satu kalimat:** Twinnear sudah punya produk live paling lengkap di tracknya, tapi **tanpa video demo submission-nya tidak valid sama sekali** — dan tanpa pengujian adversarial, juri teknis akan menempatkan Veto/Settl di atas kita.

---

## 2. Data submission segar (7 Nov malam)

| Sumber | Nilai |
|---|---|
| `/api/applications` | `{"count": 244}` (pagi: 223 → +21 dalam sehari) |
| `/api/projects` | 245 proyek, 31 halaman × 8 |
| Bertag `realworld` (track 08) | **50 proyek** |
| Tag lain (untuk konteks) | security 131, agents 123, business 44, open 42, privacy 39, defi 38, thesis 23, swarms 18, nfts 17, social 12, games 11, memecoins 5 |

**50 proyek bertag realworld:** Veridom Pay, Jurat, NairaRails, DeadDrop, Tollgate (×2), Settled, Bolsillos, PayPerCall on NEAR, Sidelot, HoldUp, AJO ON NEAR, Guardrail, Petty Cash, ZEDEC PQOS, Settl, Quittance, dareskro, PrivateDAO, Redline, Cobra on NEAR, VRX, x402-near, Agent Treasury, MilestonePay, Proof of Ship on NEAR, XAUConnect Gold Router, ClearSend Intents, Kite, Penstock, AllTrades, Invoice Link, Payproof Global, Ash., Aegis Vault, NEARPORTAL, ProofPay, Settleform, GetLeash, Roomy, TabWrit, Phylaxtag, NearPocket, Milestone Vault, Chaperone, Pull Up, Presafe, SpecLock, Heir, Supply, Kinwarden.

**Catatan metodologi:** nama duplikat ada (Tollgate ×2, Aegis, NearGuard, Allowance, NEAR Usage Thesis, Tripwire, AgentGuard, Leash, Mandate). Repo GitHub tidak ditemukan untuk sebagian nama (Sidelot, HoldUp, Guardrail, Payproof, AllTrades, VRX, Cobra, Redline, PrivateDAO, DeadDrop, Roomy, TabWrit, Presafe, Heir, Supply, Ash., Kite, GetLeash, Milestone Vault — kemungkinan repo privat, nama berbeda, atau belum di-push). dareskro ternyata payroll escrow di **XRP Ledger**, bukan NEAR. XAUConnect ternyata Solana. ZEDEC menandai 9 track sekaligus — tag bukan bukti fokus.

---

## 3. Bedah pesaing utama

### 3.1 Track 08 — pesaing invoice langsung

#### Settl — `ZSP111/settl` — ANCAMAN TERBESAR
- **Status:** TS, 102 file, push 6 Nov. **Kontrak Rust** (invoice/payment/sponsor/migrate) + mock-USDC + gasless relay + sponsored storage pool.
- **Bukti live:** **MAINNET LIVE** (`settl-billonaire.near`) dengan receipt pembayaran nyata; demo testnet juga ada. Splits 70/30, escrow dengan approve client, halaman income-proof `/proof/<account>`.
- **Tes:** **51 unit test + 4 e2e sandbox** — sama persis dengan Twinnear (51 unit).
- **1Click Intents:** terintegrasi.
- **Demo/video:** `demo-script.md` (~2:05, 7 scene, termasuk pembayaran mainnet nyata ~$1). **Tidak ada file video di repo.** Video di X tidak dapat diverifikasi (x.com diblokir untuk fetch).
- **Yang tidak dimiliki Settl:** retainer, portal klien, PDF/CSV, spend-guard, dispute, estimasi fiat, validasi live akun. Tidak ada bukti gasless end-to-end setara invoice #4 Twinnear.
- **Vonis:** satu-satunya pesaing yang mengalahkan Twinnear di satu sumbu keras (mainnet + receipt nyata). Di semua sumbu fitur lain, Twinnear unggul.

#### Invoice Link — `ayinmodeolarewaju-bot/invoice-link`
- **Status:** TS, 103 file, dibuat 26 Okt, push 7 Nov. Invoice builder + pay flow + receipt PDF, 1Click live quotes terverifikasi (dry-run, 7 rute), 30 Vitest tests + Playwright e2e, demo Vercel (mock mode default), hackathon log harian.
- **Kelemahan fatal:** **TIDAK ADA SMART CONTRACT** — invoice tersimpan server-side (Redis/Blob/SQLite). Untuk hackathon NEAR, ini rapuh di mata juri teknis.
- **Video:** punya `scripts/record-demo.mjs` (rekam mock flow 1920×1080 via Playwright, kursor terlihat, tanpa voiceover) — pipeline video ada, tapi **tidak ada file video di repo**; video final di X tidak terverifikasi.
- **Vonis:** presentasi dan disiplin proses terbaik di antara pesaing invoice (log harian, e2e), tapi tanpa kontrak ia bukan produk on-chain.

#### SpecLock — `takaolovely/speclock` — PALING ORISINAL
- **Status:** 98 file, push 6 Nov. Live app `speclock-nine.vercel.app`, testnet, factory `speclock.testnet`, verifier `verifier.speclock.testnet`.
- **Mekanisme:** setiap invoice adalah **sub-akun NEAR keyless**; agen independen meng-attest checklist deterministik, payout di-split, akun menghapus dirinya sendiri (refund storage). Client bisa `refund()` setelah deadline.
- **Kekuatan:** dokumentasi paling "serang-saya" — hash laporan reproduksibel (mengecualikan waktu), arsitektur digambarkan, dua hal yang "layak diserang" ditulis eksplisit. Ini bahasa yang disukai juri teknis.
- **Video:** tidak ada file video (hanya `scripts/refund_demo.js` + halaman `demo-target`).
- **Tes:** jumlah test tidak terverifikasi dari README.
- **Vonis:** orisinalitas tertinggi di track 08. Tapi cakupan produk lebih sempit dari Twinnear (tanpa retainer/portal/PDF/CSV/spend-guard).

#### Settle — `MFrancis-dev/settle` ("Settled")
- **Status:** 278 file, push 6 Nov. Invoice cross-chain via Intents, NEP-413 sign-in. Dokumentasi sangat kuat (ARCHITECTURE.md, ROADMAP.md, LAUNCH.md berisi draf video script + X post + submission payload).
- **Kelemahan fatal:** **TIDAK ADA SMART CONTRACT di MVP, TIDAK ADA demo live/hosting** ("Live demo URL: not published yet", `pnpm demo` lokal adalah demonya). Tidak ada pembayaran end-to-end nyata.
- **Video:** hanya draf skrip di LAUNCH.md — sama seperti Twinnear (skrip tanpa video).
- **Vonis:** paper-tiger — README terbaik, produk paling tipis. Di bawah Twinnear di semua sumbu live.

#### ProofPay — `DevBash1/proofpay`
- **Status:** TS, 37 file, dibuat + push 6 Nov dalam ~1 jam. Escrow + verifier AI/LLM, kontrak 26 test + token 2 + services 16 test, dashboard GitHub Pages baca testnet.
- **Video:** tidak ada.
- **Vonis:** tipis dan baru; bukan ancaman saat ini, tapi escrow + AI verifier adalah kombinasi yang bisa berkembang.

#### ClearSend — `dukemawex/clearsend-near`
- **Status:** TS, 70 file, push 4 Nov. Escrow + AI verifier (function-call key hanya bisa `attest`), kontrak testnet ter-deploy, Vercel hosted, halaman judges, screenshot.
- **Video:** tidak ada di README.
- **Vonis:** pesaing escrow yang solid tapi tanpa video dan tanpa retainer/portal/PDF.

#### PayPerCall — `devx-agent/near-paypercall`
- **Status:** Rust, 18 file, push 2 Nov sekali. Escrow pay-per-call API untuk AI agent, 22 unit test + sandbox e2e, demo site live.
- **Video:** hanya `video/VIDEO_BRIEF.md` — brief video 60 detik tanpa audio, teks besar. **Bukan file video.**
- **Vonis:** bukan invoice; relevansi track 08 tidak langsung.

#### Bolsillos — `tuneupargentina/bolsillos` (pesaing lama dari studi pagi)
- **Status:** JS, 87 file, push 2 Nov — **tampak berhenti sejak 2 Nov**. Household USDC pockets, factory, relayer CLI-only gasless, kontrak 16+4+7 = **27 test**.
- **Video:** **ADA — `docs/demo.mp4`, 84,0 detik, 1,7 MB**, + subtitle `.srt` + slide demo. Web UI static dist.
- **Vonis:** tetap pesaing gasless, tapi tanpa invoice/escrow/retainer/portal/PDF/CSV, dan tidak ada aktivitas 5 hari. Twinnear sudah melampauinya di semua sumbu kecuali… video (mereka punya, kita belum).

#### NairaRails — `Esimuda/nairarails`
- **Status:** TS, 78 file, push 31 Okt — tampak berhenti. Bayar tagihan Nigeria (listrik/airtime/DStv) via Intents, demo Vercel (DEMO mode, mock solver).
- **Video:** **ADA — `docs/demo/nairarails-walkthrough.mp4`, 81,5 detik, 0,86 MB**, skrip demo 75 detik + voiceover + frame.
- **Kelemahan fatal:** **TIDAK ADA SMART CONTRACT** (Next.js + 1Click API saja).
- **Vonis:** use-case dunia nyata paling konkret (tagihan Nigeria), tapi tanpa kontrak dan tanpa aktivitas seminggu.

#### Pesaing track 08 lain (dicek via GitHub search, belum dibedah dalam)
- **AJO ON NEAR** (`HATWHY4041/ajo-on-near`, push 1 Nov) — rotating savings. **Petty Cash** (`kasbsquall/petty-cash`, push 2 Nov) — budget beraturan untuk Sputnik DAO. **Quittance** (`AustinChris1/quittance`, push 3 Nov) — receipt untuk swap Intents lintas chain. **Jurat** (`nftkingiii/jurat`, push 29 Okt) — bukti saldo confidential. **Chaperone** (`techafreshh/chaperone`, push 4 Nov) — verifikasi tujuan untuk armada agen. **NearPocket** (`mozoraID/nearpocket`, push 7 Nov) — wallet QR Asia (QRIS, PromptPay, DuitNow, PayNow); menarik, baru. **Aegis Vault** (`Cubiczan/near-aegis-vault`, push 5 Nov) — firewall spend-policy agen. **Penstock** (`ace-coderr/penstock`, push 3 Nov) — x402 paywall. **Veridom Pay** (`khrisdidukh/veridom-pay`, push 31 Okt) — milestone konstruksi dibayar atas bukti inspektor AI di TEE. **Pull Up** (`Benito3262/pull-up`, push 6 Nov) — deposit event. **SpecLock** — lihat 3.1. **Kinwarden** (`JahanzaibMohsin9/kinwarden`, push 7 Nov) — tanpa deskripsi. **MilestonePay** (`sgarvit/milestonepay`) — hanya template create-next-app, tampak stub; repo hackathon sebenarnya tidak terverifikasi. **NEARPORTAL** (`unholy0X/nearportal`, push 5 Nov) — agen/dev dibayar EUR untuk merged code. **Agent Treasury** (`iskander-kudashev-13/agent-treasury`, push 3 Nov) — vault agen dengan mandate on-chain. **x402-near** (`r-near/x402-near-demo`, push 2025-11-18 — lama, kemungkinan bukan entri hackathon).

### 3.2 Lintas track — pembanding juri (standar kualitas)

#### Veto — `Bronxydrone/Veto` (security/agents) — STANDAR RIGOR TERTINGGI
- **Tes:** **94 JS test + 31 Rust test, 37 conformance check, 29 skenario adversarial, 1000 aksi acak**, demo page statis (tanpa server).
- **Video:** **ADA — `docs/shots/veto-demo.mp4`, 57,8 detik, 1,9 MB**, + `scripts/make-demo-video.ps1`.
- **Vonis:** inilah patokan rigor pengujian. Twinnear (51 unit test, tanpa adversarial/fuzz/conformance) kalah jauh di sumbu ini. Video Veto pendek, padat, dan berorientasi bukti (lihat §4).

#### Allowance — `soldanoandrea/allowance` (business/security/agents)
- **Tes & produk:** sandboxed treasury AI agent, factory, MCP, x402, attack log. 111 file, push 1 Nov.
- **Video:** **ADA — `docs/media/demo.mp4`, 117,6 detik (1:58), 1920×1080, 2,2 MB**, + `demo.gif`, hosted ledger page GitHub Pages.
- **Vonis:** video terpanjang di antara pembanding kuat; sepenuhnya rekaman terminal (lihat §4).

#### LeashPay — `hassaanraja282-lgtm/leashpay` (security/agents)
- **Video:** **ADA — `demo/LeashPay_demo.mp4`, 142,7 detik (~2:23), 4,6 MB**. Demo read-only hosted di Render. Repo push 29 Okt sekali — tampak berhenti.
- **Vonis:** video terpanjang; produk tidak berkembang sejak 29 Okt.

#### Tidepool — `Watchmeecryt/tidepool` (open)
- **Video:** **ADA — `docs/public/videos/tidepool-demo.mp4`, 84,1 detik, 2,5 MB**. Infra sandbox 1Click testnet, docs besar, live API, 224 file, push 6 Nov.
- **Vonis:** video + infra kuat; bukan pesaing track 08 langsung.

#### NEAR Agent Spend Guard — `mubudot/near-agent-spend-guard` (security)
- **Video:** **ADA — YouTube 2:07** (`https://youtu.be/XA7GZ8nHDVM`, per README). Dashboard read-only live GitHub Pages, skenario prompt-injection, `scripts/video/make_demo.py`.
- **Vonis:** satu-satunya video YouTube di antara pembanding; durasi 2:07 mendekati target Twinnear.

#### NEAR Private OTC — `Watchmeecryt/near-private-otc`
- **Status:** TS, 76 file, push 31 Okt. Private OTC deal board, live Railway app, demo API via curl (2 menit). **Tidak ada video ditemukan.**

---

## 4. Video demo pesaing — temuan lengkap

### 4.1 Tabel video

| Pesaing | Video? | Durasi | Platform / lokasi | Isi & produksi | Kekuatan | Kelemahan |
|---|---|---|---|---|---|---|
| **Bolsillos** | ✅ ADA | 84,0 dtk | Repo `docs/demo.mp4` (1,7 MB) + `.srt` | Slide bernomor + data on-chain nyata (tx hash, signer `b575-relayer.testnet`, EVENT_JSON, "Relayer pays the gas; withdraw_pocket lands on-chain") | Bukti on-chain konkret di layar; subtitle | Slide deck, bukan walkthrough produk live; tanpa narasi manusia yang terdengar |
| **NairaRails** | ✅ ADA | 81,5 dtk | Repo `docs/demo/nairarails-walkthrough.mp4` (0,86 MB) | Walkthrough + voiceover + frame, skrip 75 dtk | Voiceover + alur end-to-end | Produk mock (DEMO mode); tanpa kontrak |
| **Veto** | ✅ ADA | 57,8 dtk | Repo `docs/shots/veto-demo.mp4` (1,9 MB) | Slide judul besar ("The walls are on-chain, not in the agent") + rekaman terminal skrip demo testnet: kontrak, kunci agen, tx, penolakan (`deny:PER_TX_LIMIT`, `deny:DAILY_LIMIT`), pre-flight check | Sangat padat, bukti penolakan on-chain ditampilkan; durasi pendek = mudah ditonton juri | Tanpa UI produk; hanya slide + terminal; tanpa narasi manusia |
| **Allowance** | ✅ ADA | 117,6 dtk | Repo `docs/media/demo.mp4` (2,2 MB) + `demo.gif` | Rekaman terminal murni (script-recorded, tanpa edit): agen, policy, pending approval, tabel receipt | Sangat teknis, meyakinkan untuk juri teknis | Terminal saja — tidak ramah juri non-teknis; tanpa UI, tanpa narasi |
| **LeashPay** | ✅ ADA | 142,7 dtk | Repo `demo/LeashPay_demo.mp4` (4,6 MB) | (durasi terverifikasi ffprobe; isi frame tidak diinspeksi) | Terpanjang | Repo berhenti 29 Okt |
| **Tidepool** | ✅ ADA | 84,1 dtk | Repo `docs/public/videos/tidepool-demo.mp4` (2,5 MB) | (durasi terverifikasi ffprobe; isi frame tidak diinspeksi) | Infra live | Bukan track 08 |
| **NEAR Agent Spend Guard** | ✅ ADA | 2:07 | YouTube | Video YouTube (per README); skenario prompt-injection | Satu-satunya di YouTube; durasi ideal | Bukan track 08; isi tidak ditonton (hanya klaim README) |
| **Settl** | ❌ tidak ditemukan | — | — | Hanya `demo-script.md` (~2:05, 7 scene, termasuk bayar mainnet nyata ~$1) | Skrip matang; adegan mainnet nyata direncanakan | **Tidak ada file video di repo**; video X tidak terverifikasi |
| **Invoice Link** | ⚠️ tidak terverifikasi | — | Pipeline `scripts/record-demo.mjs` (Playwright 1920×1080, kursor terlihat) | Merekam mock flow: builder → create → pay → quote → deposit → simulate → receipt | Pipeline otomatis, mudah diulang | **Tidak ada file video di repo**; video final di X tidak terverifikasi |
| **SpecLock** | ❌ tidak ditemukan | — | — | Hanya `scripts/refund_demo.js` + halaman `demo-target` | Demo interaktif di web | Tanpa video |
| **Settle** | ❌ tidak ditemukan | — | — | Hanya draf skrip di `LAUNCH.md` | Skrip + draf X post siap | Tanpa video, tanpa produk live |
| **ClearSend** | ❌ tidak ditemukan | — | — | Screenshot saja | Halaman judges | Tanpa video |
| **ProofPay** | ❌ tidak ditemukan | — | — | — | — | Tanpa video |
| **PayPerCall** | ⚠️ brief saja | 60 dtk (rencana) | `video/VIDEO_BRIEF.md` | Brief video bisu 60 dtk, teks besar, tanpa audio | Rencana jelas | **Bukan file video** |
| **Twinnear** | ❌ BELUM ADA | — | — | Hanya skrip ~2,5 menit + narasi Inggris di `~/workspace/goals/twinnear-near-hackathon/DEMO_AND_SUBMISSION.md` | Skrip sudah ada; semua adegan sudah terbukti live | **Tanpa video = submission tidak valid** |

### 4.2 Apa yang dipelajari dari frame video pesaing (diinspeksi langsung)

Tiga video diunduh dan frame tengahnya dibaca:

- **Bolsillos (tengah, ~42 dtk):** slide "4 · Explorer: gasless tx · from testnet RPC" menampilkan kartu TRANSACTION HASH `4RYWb3CeX7jG9hQgEx5DRDvHCjoyJyhR9izowDh5ieF`, SIGNER `b575-relayer.testnet`, RECEIVER `b575-mom.testnet`, RECEIPTS 6, GAS BURNT, LOGS berisi `EVENT_JSON {"standard":"bolsillos","version":"1.0.0","event":"withdraw_pocket"...}`, dan caption bawah "Relayer pays the gas; withdraw_pocket lands on-chain". **Pola:** bukti on-chain ditampilkan sebagai kartu, bukan terminal mentah.
- **Allowance (tengah, ~59 dtk):** terminal penuh: daftar agen (`ed25519:DCHN6U...cJkBU "worker" active, policy v1, 2 payments, 1.48 NEAR left`), per-payment cap, budget, payee, human approval, auto-disable; pending approval #0 (0.8 NEAR → api.sandbox); tabel receipt #0–#4 (paid/pending). **Pola:** kredibilitas lewat detail mentah — tapi membosankan dan tidak ramah juri non-teknis.
- **Veto (tengah, ~29 dtk, slide 5/9):** judul besar "4. The walls are on-chain, not in the agent" + subjudul + terminal `node scripts/testnet-demo.ts`: contract, agent, vendor, policy (hash), daftar transaksi (deploy, new owner, agent adds spend-only key, agent deletes full key, owner installs policy, agent spends 0.25 NEAR), **refusals** (agent tries 1.5 NEAR → reverted `PER_TX_LIMIT`, deny event; agent tries set_paused → rejected), state read-back, pre-flight `check(0.1) → allow` / `check(5.0) → deny:PER_TX_LIMIT` / `check(stranger) → deny:RECIPIENT_NOT_ALLOWED`, rolling daily window. **Pola terbaik:** satu slide = satu klaim + bukti terminal yang membuktikan klaim itu, termasuk bukti *penolakan* (yang gagal) — jauh lebih meyakinkan daripada hanya menunjukkan yang berhasil.

**Pola umum video pesaing:** durasi 58 detik–2:23; semuanya rekaman layar/slide + teks di layar; bukti on-chain (tx hash, terminal, penolakan) adalah mata uang kredibilitasnya; **tidak satu pun** yang menampilkan walkthrough produk web yang dipoles dengan narasi manusia. Itu celah Twinnear.

### 4.3 Rekomendasi konkret untuk video Twinnear

**Durasi ideal: 2:00–2:30** (skrip yang ada ~2,5 menit sudah di rentang benar; jangan lebih dari 2:30 — video terpanjang pesaing 2:23, dan juri menonton puluhan video).

**Prinsip pembeda:** semua video pesaing adalah *proof reel* teknis (slide/terminal). Video Twinnear harus jadi **walkthrough produk manusiawi + bukti on-chain** — satu-satunya video yang menunjukkan freelancer sungguhan (bukan terminal) memakai produk, DITAMBAH kartu bukti tx seperti Bolsillos/Veto. Narasi Inggris (sesuai skrip), rekaman layar HP + desktop, teks besar di layar untuk setiap klaim.

**Urutan adegan yang disarankan (7 adegan, ~2:15):**

| # | Adegan (durasi) | Yang ditunjukkan | Bukti di layar |
|---|---|---|---|
| 1 | Masalah (0:00–0:15) | Freelancer menunggu dibayar; invoice biasa = janji tanpa jaminan | Teks: "Freelancers wait. Clients ghost." |
| 2 | Buat invoice (0:15–0:40) | Buat invoice di twinnear.vercel.app: client `0xward.testnet`, line items + pajak, PDF terunduh | UI live + PDF |
| 3 | **Gasless — momen kunci** (0:40–1:10) | Client bayar TANPA gas: popup Meteor → tanda tangan NEP-413 → invoice #4 (atau baru) terbuat; seller tidak bayar gas | Popup Meteor terekam; kartu tx hash `2iMVmF…` / tx baru; teks "Seller paid 0 gas" |
| 4 | Escrow + release (1:10–1:35) | Dana terkunci di escrow → client approve → release; status berubah PENDING → PAID → RELEASED | Timeline status di halaman invoice publik |
| 5 | Spend-guard menolak (1:35–1:55) | Coba bayar di atas `max_amount` / di luar allowlist → **ditolak kontrak** (ala Veto: tunjukkan penolakan, bukan hanya sukses) | Pesan deny di layar; teks "The contract says no — not the app" |
| 6 | Retainer + portal + CSV (1:55–2:10) | Retainer berulang, portal klien tanpa login, unduh CSV | UI portal + file CSV |
| 7 | Penutup + verifikasi (2:10–2:20) | "Verify it yourself in 2 minutes" + link repo + kontrak `twinnear.testnet` v3 | Teks + QR/link; tag @NEARProtocol + #NEARHackathon di post X |

**Yang harus DIHINDARI:** jangan meniru Allowance (terminal 2 menit penuh) — juri non-teknis akan bosan; jangan meniru Invoice Link (mock mode) — semua adegan Twinnear harus live testnet, bukan mock; jangan klaim mainnet (kita testnet-only — jujur seperti README).

**Catatan produksi:** rekam di HP (pengguna sudah punya alur Termux + Meteor); pakai invoice kecil 0,05–0,1 NEAR untuk demo (sisa liquid ~0,7 NEAR); simpan file video JUGA di repo (`docs/demo.mp4`, seperti Bolsillos/Veto/Allowance) supaya juri yang membuka repo langsung menemukannya — jangan hanya di X.

---

## 5. Tabel perbandingan Twinnear vs pesaing utama

| Kriteria | Twinnear | Settl | Invoice Link | SpecLock | Bolsillos | Veto (lintas track) |
|---|---|---|---|---|---|---|
| Kontrak live | ✅ v3 testnet | ✅ testnet + **mainnet** | ❌ tidak ada | ✅ testnet (factory) | ✅ testnet | ✅ testnet |
| Gasless terbukti end-to-end | ✅ **invoice #4, tx nyata** | ✅ relay (klaim; bukti live tidak sekuat Twinnear) | ❌ | ❌ | ✅ CLI-only | ❌ (bukan gasless) |
| Invoice | ✅ | ✅ | ✅ (server-side) | ✅ (keyless sub-akun) | ❌ | ❌ |
| Escrow | ✅ | ✅ | ❌ | ✅ (terkunci di sub-akun) | ❌ | ❌ |
| Dispute | ✅ | ❌ | ❌ | ❌ (fail = tetap Funded) | ❌ | ❌ |
| Retainer / berulang | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Portal klien | ✅ | ❌ | ❌ (receipt saja) | ❌ | ❌ | ❌ |
| PDF / CSV | ✅ | ❌ | ✅ PDF | ❌ | ❌ | ❌ |
| Spend-guard | ✅ (celah USDC diketahui, diakui di FAQ) | ❌ | ❌ | ❌ | ❌ (pockets saja) | ✅ (ini produknya) |
| Estimasi fiat | ✅ CoinGecko | ❌ | ❌ | ❌ | ❌ | ❌ |
| 1Click / Intents | ✅ (USDC via 1Click; tanpa testnet) | ✅ | ✅ (quotes live) | ❌ | ❌ | ❌ |
| Unit test | **51** | **51 + 4 e2e** | 30 + Playwright e2e | tidak terverifikasi | 27 | 94 JS + 31 Rust |
| Adversarial / fuzz / conformance | ❌ belum ada | tidak terverifikasi | ❌ | ❌ | ❌ | ✅ 37 + 29 + 1000 acak |
| Migrasi kontrak | ✅ v2→v3 live | ✅ migrate | ❌ | ❌ | ❌ | ❌ |
| Demo hosted | ✅ Vercel | ✅ testnet + mainnet | ✅ Vercel (mock) | ✅ Vercel | ✅ static dist | ✅ static page |
| Demo tanpa wallet | ✅ halaman invoice publik | ✅ `/proof/<account>` | ✅ mock mode | ✅ demo-target | ❌ | ✅ static page |
| Video demo | ❌ **belum ada** | ❌ tidak ditemukan | ⚠️ pipeline saja | ❌ | ✅ 84 dtk | ✅ 58 dtk |
| Dokumentasi verifikasi mandiri | ✅ `verify-in-2-minutes.md` | ✅ demo-script | ✅ hackathon log | ✅ hash reproduksibel | ✅ | ✅ |
| README akurat saat ini | ⚠️ **basi: tulis v2 / 50 test** (kode sudah v3 / 51 test) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mainnet readiness | ❌ testnet-only (disengaja) | ✅ live | ❌ | ❌ | ❌ | ❌ |

**Klaim Twinnear yang diverifikasi ulang malam ini (bukan dari catatan):** `get_invoice_count` → 4 (RPC testnet langsung); `/api/health` → `configured:true`, balance 0.500 NEAR; 51 `#[test]` di `contract/src/lib.rs`, `get_version` → 3 di kode; wasm SHA `2894e4310c6972a2420bb02502cb60b9b84b13b51308966a9cca79669ee20835`.

---

## 6. Celah untuk jadi nomor 1 — apa yang masih kurang

1. **Video demo = gerbang submission.** Tanpa video di X, submission tidak valid — ini bukan soal skor, ini soal *bisa ikut atau tidak*. Semua pesaing serius sudah punya video atau skrip matang. Ini satu-satunya item yang **wajib** sebelum 15 Nov.
2. **Rigor pengujian adversarial.** Veto menetapkan standar: conformance + adversarial + fuzz. Twinnear 51 unit test setara Settl, tapi juri teknis yang membandingkan dengan Veto akan melihat Twinnear belum menguji "apa yang terjadi saat diserang". Celah USDC spend-guard yang sudah diakui adalah contoh persis yang akan ditanyakan juri.
3. **Mainnet.** Settl satu-satunya dengan mainnet live + receipt nyata. Twinnear testnet-only adalah keputusan sadar (biaya deploy mainnet ~2,5 NEAR tidak ada), dan aturan mengizinkan testnet-only — tapi ini tetap satu-satunya sumbu di mana Settl menang telak. Tidak bisa ditutup tanpa dana; yang bisa dilakukan: buat keunggulan testnet-nya tak terbantahkan (video + adversarial + dokumentasi).
4. **README basi.** Klaim v2/50 test di README vs kenyataan v3/51 test — juri yang memverifikasi akan menemukan ketidakcocokan dalam 2 menit. Ini merusak kepercayaan yang dibangun `verify-in-2-minutes.md`.
5. **Celah spend-guard USDC.** Sudah diakui jujur di About/FAQ (nilai plus), tapi tetap satu asterisk teknis. Perbaikan = kontrak v3 + migrasi (P1, belum dikerjakan; butuh tanda tangan pengguna via Termux).
6. **Alamat payout mainnet belum dibuat.** Wajib untuk form submission; implicit account 64-hex gratis — tinggal dibuat.
7. **Portal belum diuji sebagai 0xward.testnet.** Jalur demo yang belum teruji = risiko gagal saat direkam/didemo juri.

---

## 7. Rekomendasi berprioritas (urut dampak terhadap peluang juara)

| # | Rekomendasi | Usaha | Dampak | Alasan |
|---|---|---|---|---|
| 1 | **Rekam + posting video demo (2:00–2:30, 7 adegan §4.3), simpan juga `docs/demo.mp4` di repo** | Besar (1–2 hari: rekam HP, edit, narasi) | **TERTINGGI — gerbang submission** | Tanpa ini submission tidak valid. Video Twinnear bisa jadi yang terbaik di track karena satu-satunya walkthrough manusiawi + bukti on-chain, vs slide/terminal pesaing. |
| 2 | **Perbaiki README: v2→v3, 50→51 test, tambah tautan video + `verify-in-2-minutes.md`** | Kecil (<1 jam) | Tinggi | Menutup ketidakcocokan yang juri temukan dalam 2 menit; menjaga kredibilitas dokumentasi yang selama ini jadi keunggulan. |
| 3 | **Tambah 20–30 test adversarial/conformance ala Veto** (bypass spend-guard, double-pay, refund setelah release, dispute edge cases, `max_amount` USDC, migrasi state) | Sedang–besar (1–2 hari) | Tinggi | Satu-satunya cara menutup jarak rigor vs Veto/Settl; sekaligus membuktikan celah USDC sudah ditangani atau terdokumentasi dengan test. |
| 4 | **Buat alamat payout NEAR mainnet (implicit 64-hex, gratis)** | Kecil (<30 mnt) | Tinggi (wajib form) | Tanpa ini form submission tidak bisa diisi. |
| 5 | **Perbaiki celah spend-guard USDC (kontrak v3 + migrasi) — bila sempat setelah #1–#3** | Besar (kontrak + migrasi + tanda tangan Termux) | Sedang–tinggi | Menghapus satu-satunya asterisk teknis; tapi pengakuan jujur di FAQ sudah meredamnya — kalah penting dari video + test. |
| 6 | **Uji portal sebagai 0xward.testnet + tambah halaman "bukti" publik** (invoice + tx + relayer, ala `/proof/` Settl) | Kecil–sedang | Sedang | Menutup jalur demo yang belum teruji; halaman bukti memperkuat klaim gasless di depan juri tanpa wallet. |
| 7 | **Submit lebih awal (sebelum 14 Nov) + post X dengan video** | Kecil | Sedang | Menghindari antrean deadline; post X lebih awal = lebih banyak waktu dilihat. Tag @NEARProtocol + #NEARHackathon, dari @arawrdn. |

**Urutan kerja 8 hari yang disarankan:** hari 1: #2 + #4 + #6 (kecil, fondasi) → hari 2–3: #1 video (rekam + edit + post) → hari 4–5: #3 test adversarial → hari 6: #5 bila sempat → hari 7: submit + buffer.

---

## 8. Metodologi & ketidakpastian (jujur)

- **x.com DIBLOKIR untuk fetch** — semua video/klaim di post X pesaing (termasuk video Settl dan Invoice Link yang mungkin sudah diposting) berstatus **tidak terverifikasi**, bukan "tidak ada". Jangan jadikan ini dasar klaim keunggulan.
- **Video yang tidak bisa diakses ditulis "tidak ditemukan"**, bukan dikarang isinya. Isi frame hanya dinilai untuk 3 video yang diunduh (Bolsillos, Allowance, Veto); LeashPay, Tidepool, dan video YouTube Spend Guard hanya durasinya yang terverifikasi ffprobe/README.
- **Jumlah test pesaing** diambil dari README masing-masing; tidak dijalankan ulang. Settl "51+4" dan Veto "94+31+37+29+1000" adalah klaim repo — belum dieksekusi mandiri.
- **Tag track ≠ fokus utama.** Banyak proyek menandai banyak track; peringkat di sini memakai isi repo, bukan tag.
- **Data API hackathon** diambil 7 Nov malam; jumlah aplikasi naik ~21/hari — angka akan berubah sebelum deadline.
- **Tidak ada rubrik berbobot 2026 yang dipublikasikan** — kriteria juri (technical implementation, design, impact, originality, sustainability) memakai panduan historis.
- File data mentah: `/tmp/all_projects.json` (245 proyek), `/tmp/proj_p*.json` (halaman API) — di /tmp, bisa hilang; ringkasan kunci ada di laporan ini.
