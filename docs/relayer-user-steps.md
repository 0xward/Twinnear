# Relayer gasless Twinnear - langkah pengguna (HP, Termux + proot Ubuntu)

Tujuan: menghidupkan relayer gasless di `https://twinnear.vercel.app/api`
supaya pembuatan invoice bisa tanpa gas dari dompet penjual. Kode
serverless-nya sudah di-push dan ter-deploy di Vercel (cek
`https://twinnear.vercel.app/api/health`: untuk sekarang
`configured:false`). Langkah-langkah di bawah mengaktifkannya.
Kontrak tidak disentuh: yang berubah hanya akun relayer baru, dua env
var di dashboard Vercel, dan satu panggilan `set_relayer` di kontrak.

> PERINGATAN KUNCI: private key HANYA masuk ke dashboard Vercel milikmu
> sendiri (langkah 8). JANGAN PERNAH mengirim private key ke siapa pun,
> termasuk ke agen mana pun, lewat chat, screenshot, atau file. Agen
> tidak pernah butuh private key kamu. Kalau ada yang memintanya,
> tolak.

> Semua perintah di bawah dijalankan di HP, di dalam Ubuntu proot-distro
> (pola yang sama seperti deploy dan migrasi sebelumnya). Jangan
> jalankan perintah `near` di Termux langsung di luar proot: binary-nya
> beda arsitektur dan tidak jalan.

## 1. Masuk ke Ubuntu di Termux

```bash
proot-distro login ubuntu
```

## 2. Periksa near-cli-rs terpasang

```bash
near --version
```

Hasil yang benar: `near-cli-rs 0.31.1`. Kalau belum terpasang, pasang
dulu binary aarch64 mengikuti "Termux (phone)" di `DEPLOY.md`, lalu
ulangi langkah ini.

## 3. Periksa kunci twinnear.testnet ada di keychain lama

```bash
ls ~/.near-credentials/testnet/
```

Harus ada file `twinnear.testnet.json`. Kalau tidak ada, impor dulu
kuncinya sendiri mengikuti "Key handling" di `DEPLOY.md` (perintah
`near account import-account using-private-key ... save-to-legacy-keychain`).
Tanpa kunci ini langkah 5 dan 10 tidak bisa jalan.

## 4. Periksa saldo twinnear.testnet cukup

Buka di browser HP: `https://testnet.nearblocks.io/accounts/twinnear.testnet`

Saldo harus di atas 0,6 NEAR: 0,5 NEAR untuk mendanai akun relayer baru
(langkah 5) plus sedikit gas untuk dua transaksi. Kalau saldo kurang,
isi dulu dari faucet `https://near-faucet.io` (masukkan
`twinnear.testnet`), lalu lanjut.

## 5. Buat akun relayer.twinnear.testnet

Satu perintah, didanai 0,5 NEAR dari twinnear.testnet. Kunci baru dibuat
otomatis dan disimpan ke legacy keychain:

```bash
near account create-account fund-myself relayer.twinnear.testnet '0.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send
```

Tunggu sampai transaksi sukses. Kalau gagal karena saldo kurang,
kembali ke langkah 4.

## 6. Periksa akun relayer sudah ada

```bash
near contract call-function as-read-only twinnear.testnet get_relayer json-args '{}' network-config testnet now
```

Abaikan dulu hasilnya (relayer belum diset, jadi jawabannya masih
`null`). Yang penting perintah ini jalan tanpa error jaringan. Untuk
memastikan akunnya ada, buka di browser HP:
`https://testnet.nearblocks.io/accounts/relayer.twinnear.testnet`
dan pastikan halamannya menampilkan akun, bukan "account does not exist".

## 7. Tampilkan private key akun relayer

```bash
cat ~/.near-credentials/testnet/relayer.twinnear.testnet.json
```

Output-nya JSON berisi `account_id`, `public_key`, dan `private_key`.
Salin HANYA nilai `private_key` (diawali `ed25519:`). Jangan salin
seluruh file, jangan kirim file ini ke siapa pun, jangan screenshot
dan membagikannya. Nilai ini hanya dipakai di langkah 8.

## 8. Set dua env var di dashboard Vercel

Buka di browser HP: `https://vercel.com` lalu masuk ke proyek
`twinnear` (scope `aradeas-projects`) ke menu
Settings lalu Environment Variables, pilih Environment
`Production`, lalu tambah dua var ini:

- `RELAYER_ACCOUNT_ID` = `relayer.twinnear.testnet`
- `RELAYER_PRIVATE_KEY` = nilai `private_key` dari langkah 7 (tempel
  persis, tanpa spasi tambahan, tanpa tanda kutip)

Simpan keduanya. Env var lain yang dibutuhkan relayer
(`CONTRACT_ID`, `RELAYER_ALLOWED_SELLERS`, `RELAYER_CORS_ORIGINS`,
`RELAYER_RATE_LIMIT_PER_HOUR`, `VITE_RELAYER_URL`) diurus koordinator,
bukan kamu.

## 9. Jalankan set_relayer di kontrak

Kembali ke Termux (masih di dalam Ubuntu proot). Perintah ini memberi
tahu kontrak bahwa `relayer.twinnear.testnet` adalah relayer tepercaya.
Hanya owner (`twinnear.testnet`) yang bisa menjalankannya:

```bash
near contract call-function as-transaction twinnear.testnet set_relayer json-args '{"relayer": "relayer.twinnear.testnet"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send
```

Tunggu sampai transaksi sukses.

## 10. Verifikasi relayer sudah tercatat di kontrak

```bash
near contract call-function as-read-only twinnear.testnet get_relayer json-args '{}' network-config testnet now
```

Hasil yang benar: `"relayer.twinnear.testnet"`. Kalau masih `null`,
ulangi langkah 9 dan periksa pesan error-nya.

## 11. Kabari koordinator

Kirim kabar ke koordinator bahwa langkah 5 sampai 10 selesai, sertakan
hasil langkah 10 (`"relayer.twinnear.testnet"`) dan konfirmasi bahwa
kedua env var di langkah 8 sudah disimpan. Jangan sertakan private key
di kabar itu.

Koordinator selanjutnya: redeploy Vercel supaya env var baru terbaca
fungsi serverless, lalu memeriksa
`https://twinnear.vercel.app/api/health` (harus `configured:true`
dan menampilkan saldo relayer) dan menguji checkbox gasless di halaman
New Invoice. Uji klik gasless dengan Meteor asli tetap urusanmu nanti
setelah deploy hijau.

## Kalau nanti relayer mau dimatikan

```bash
near contract call-function as-transaction twinnear.testnet set_relayer json-args '{"relayer": null}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send
```

Perintah ini menghapus relayer dari kontrak; pembuatan invoice gasless
berhenti dan yang tersisa hanya jalur langsung (penjual bayar gas).
