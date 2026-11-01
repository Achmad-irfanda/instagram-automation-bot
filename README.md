# 📸 Instagram Automation Bot & Google Drive Sync

<p align="center">
  <img src="https://img.shields.io/badge/Author-Achmad%20Irfanda-blue?style=for-the-badge" alt="Author">
  <img src="https://img.shields.io/badge/Node.js-18%2B-green?style=for-the-badge&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Playwright-Automation-red?style=for-the-badge&logo=playwright" alt="Playwright">
  <img src="https://img.shields.io/badge/Google%20Drive-API%20Sync-yellow?style=for-the-badge&logo=googledrive" alt="Google Drive">
  <img src="https://img.shields.io/badge/License-MIT-purple?style=for-the-badge" alt="License">
</p>

Otomasi Instagram cerdas dan modern berbasis **Playwright**. Dilengkapi kemampuan **crawling postingan berdasarkan rentang tanggal**, otomatis memberi **Like**, mengirim **komentar acak (anti-spam)**, mengambil **screenshot bukti interaksi**, serta **mengunggah bukti ke Google Drive per subfolder bulan** dan **menghapus file lokal otomatis** untuk menghemat penyimpanan disk.

Dibuat & dikembangkan oleh: **Achmad Irfanda** ([@Achmad-irfanda](https://github.com/Achmad-irfanda)).

---

## 🌟 Fitur Utama

- 🚀 **Batch Processing Cepat**: Membuka browser cukup 1 kali untuk memproses seluruh postingan berurutan secara mulus (*persistent session*).
- 📅 **Date-based Crawler & Auto-Run**: Cukup tentukan rentang tanggal, bot otomatis mengumpulkan URL postingan, memasukkannya ke daftar, dan langsung mengeksekusinya (`--run`).
- 🎲 **Smart Random Comments**: Memilih komentar bervariasi dari bank kalimat tanpa pengulangan kalimat yang sama secara beruntun.
- 📁 **Grouping Screenshot per Bulan**: Screenshot dikelompokkan ke subfolder bulan & tahun asli postingan dibuat (contoh: `Oktober 2026/`).
- ☁️ **Integrasi Google Drive Cerdas**:
  - Mengecek apakah folder bulan sudah ada di folder sharing Google Drive.
  - Jika **sudah ada**, langsung memasukkan file ke dalam folder tersebut (*reuse*).
  - Jika **belum ada**, otomatis membuat folder bulan baru di Drive.
  - Mencegah upload duplikat (*skip* jika file dengan nama sama sudah ada).
- 🗑️ **Local Storage Auto-Cleanup**: Setelah screenshot sukses ter-upload ke Google Drive, file lokal dan subfolder kosong otomatis dihapus agar memori laptop tetap bersih 100%.
- 🛡️ **Human-like Timing & Error Isolation**: Dilengkapi random delay (10–20 detik) untuk keamanan dari batas limit Instagram, serta penanganan error per URL agar bot tidak berhenti saat satu postingan bermasalah.
- 🔄 **Dua Pilihan Mode**: Bisa dijalankan **Standalone via Terminal (Rekomendasi)** atau diorkestrasi via **n8n + PM2**.

---

## 📂 Struktur Project

```text
instagram-automation-bot/
├── ig-bot.js                 # Core engine Playwright (Like, Comment, Screenshot per bulan)
├── run-batch.js              # Runner batch untuk mengeksekusi list URL berurutan
├── google-drive.js           # Modul sinkronisasi & upload otomatis ke Google Drive
├── get-urls-by-date.js       # Tool crawling URL postingan target berdasarkan tanggal
├── uri-comment.js            # Bank kalimat komentar & daftar URL target
├── login.js                  # Helper login awal untuk menyimpan sesi browser
├── posts-by-date.json        # Output cache hasil crawling
├── gdrive-auth.example.json  # Template konfigurasi kredensial Google Drive
├── gdrive-auth.json          # (Di-ignore) File kredensial asli Google Drive Anda
├── ig-session/               # (Di-ignore) Cache sesi browser agar login permanen
├── screenshots/              # (Di-ignore) Folder sementara hasil tangkapan layar
├── package.json
└── README.md
```

---

## 🛠️ Panduan Instalasi (Step-by-Step)

### 1. Clone Repositori
```bash
git clone https://github.com/Achmad-irfanda/instagram-automation-bot.git
cd instagram-automation-bot
```

### 2. Install Dependensi & Browser Chromium
Pastikan Anda sudah menginstall [Node.js](https://nodejs.org/) (versi 18 ke atas disarankan):
```bash
npm install
npx playwright install chromium
```

### 3. Setup Login Akun Instagram (Cukup 1 Kali)
Agar bot tidak perlu login berulang kali dan tidak terkena verifikasi keamanan:
```bash
node login.js
```
1. Browser Chromium akan terbuka secara otomatis.
2. Masukkan *Username* dan *Password* akun Instagram Anda secara manual hingga berhasil masuk ke beranda.
3. Kembali ke terminal dan tekan **`Ctrl + C`** untuk menyimpan sesi.
4. Sesi akan tersimpan aman di folder lokal `ig-session/`.

---

## ☁️ Konfigurasi Google Drive (GCP OAuth)

Agar tangkapan layar bukti interaksi dapat otomatis diunggah ke Google Drive:

1. Buat project di [Google Cloud Console](https://console.cloud.google.com/).
2. Aktifkan **Google Drive API** pada project Anda.
3. Masuk ke **APIs & Services > Credentials** > Buat **OAuth Client ID** (Application Type: *Web Application*).
4. Tambahkan Authorized redirect URI:
   ```text
   http://localhost:5678/rest/oauth2-credential/callback
   ```
5. Dapatkan `Client ID` dan `Client Secret`.
6. Salin template konfigurasi:
   ```bash
   cp gdrive-auth.example.json gdrive-auth.json
   ```
7. Buka file `gdrive-auth.json` dan isi nilai yang sesuai:
   ```json
   {
     "clientId": "YOUR_GCP_CLIENT_ID.apps.googleusercontent.com",
     "clientSecret": "YOUR_GCP_CLIENT_SECRET",
     "refreshToken": "YOUR_GCP_REFRESH_TOKEN",
     "parentFolderId": "ID_FOLDER_GOOGLE_DRIVE_TUJUAN"
   }
   ```
   *(ID Folder tujuan diambil dari URL Google Drive Anda, misalnya: `https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw` -> ID-nya adalah `1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw`)*.

> [!IMPORTANT]
> File `gdrive-auth.json` sudah dimasukkan ke `.gitignore` sehingga data rahasia (*Client Secret* & *Refresh Token*) Anda tidak akan pernah bocor ke publik.

---

## 🚀 Cara Menjalankan Bot

### 🌟 Mode 1: All-in-One (Crawl Berdasarkan Tanggal & Auto-Run) — *Paling Praktis*
Bot akan menyaring postingan akun target pada periode tertentu, memasukkan URL ke daftar, lalu langsung mengeksekusi Like, Komentar, Screenshot, Upload ke Google Drive, dan menghapus file lokal:

```bash
node get-urls-by-date.js <USERNAME_TARGET> <START_DATE> <END_DATE> --run
```

**Contoh:**
```bash
node get-urls-by-date.js interactivetech 2026-10-01 2026-10-31 --run
```
*(Jika dijalankan tanpa `--run`, bot hanya akan menyimpan URL ke `uri-comment.js` tanpa langsung mengeksekusinya)*.

---

### 📋 Mode 2: Batch Runner dari Daftar URL Khusus
Jika Anda sudah memiliki daftar URL postingan sendiri:
1. Buka file [`uri-comment.js`](uri-comment.js).
2. Masukkan link postingan pada array `urlPost`:
   ```javascript
   const urlPost = [
     "https://www.instagram.com/p/DfHNPOiCTjb/",
     "https://www.instagram.com/p/DfEvClTiaOe/"
   ];
   ```
3. Jalankan bot batch:
   ```bash
   node run-batch.js
   ```
   *(atau bisa langsung: `node uri-comment.js`)*.

---

### 🎯 Mode 3: Manual Satuan (Single Post Test)
Untuk menguji coba pada 1 postingan saja:
```bash
# Komentar kustom:
node ig-bot.js "https://www.instagram.com/p/xxxx/" "Semangat berkarya kak! 🔥"

# Komentar acak otomatis dari bank kalimat:
node ig-bot.js "https://www.instagram.com/p/xxxx/"
```

---

### 🔄 Mode 4: Sinkronisasi Ulang Google Drive
Jika terdapat screenshot lokal yang belum terunggah ke Google Drive:
```bash
node google-drive.js
```

---

## 🤖 (Opsional) Menjalankan via n8n & PM2 di Lokal

Jika Anda lebih menyukai antarmuka visual n8n dengan form trigger:

### 1. Install PM2 & n8n secara Global
```bash
npm install -g pm2 n8n
```

### 2. Jalankan n8n Menggunakan PM2 dengan Izin Akses Disk & Command
```bash
NODES_INCLUDE='["n8n-nodes-base.executeCommand"]' N8N_BLOCK_FS_READ_ACCESS=false pm2 start n8n --name "n8n-local"
pm2 save
```

### 3. Akses n8n Dashboard
1. Buka browser dan kunjungi `http://localhost:5678`.
2. Buat akun admin lokal n8n Anda.
3. Hubungkan kredensial **Google Drive OAuth2** di menu *Credentials* menggunakan `Client ID` dan `Client Secret` dari GCP.
4. Import workflow atau gunakan node **Execute Command** untuk menjalankan `node ig-bot.js`.

---

## ⚙️ Kustomisasi & Konfigurasi

### Mengatur Jeda Waktu Anti-Spam (Delay)
Untuk menjaga akun dari pembatasan Instagram (*action limit*), jeda antar postingan diatur acak. Anda dapat mengubah nilainya di file [`run-batch.js`](run-batch.js):
```javascript
const MIN_DELAY_SECONDS = 10; // Jeda minimum (detik)
const MAX_DELAY_SECONDS = 20; // Jeda maksimum (detik)
```

### Menambah Variasi Komentar
Buka file [`uri-comment.js`](uri-comment.js) dan tambahkan variasi komentar pada array `comments`. Semakin banyak variasi, semakin aman akun Anda dari deteksi spam bot.

---

## 🔒 Keamanan & Privasi Data

File berikut **bersifat rahasia dan TIDAK BOLEH di-push ke repositori publik**:
- 🚫 `ig-session/`: Berisi cookie autentikasi dan session login aktif Instagram Anda.
- 🚫 `gdrive-auth.json`: Berisi Refresh Token & Client Secret akun Google Anda.
- 🚫 `client_secret_*.json`: File OAuth credential bawaan GCP.
- 🚫 `screenshots/`: Berisi tangkapan layar akun Instagram.

Semua item di atas sudah otomatis terdaftar di file [`.gitignore`](.gitignore).

---

## 👨‍💻 Author

Dikembangkan oleh:  
**Achmad Irfanda**  
- **GitHub**: [@Achmad-irfanda](https://github.com/Achmad-irfanda)  
- **Project**: [instagram-automation-bot](https://github.com/Achmad-irfanda/instagram-automation-bot)

---

## 📄 Lisensi

Project ini dilisensikan di bawah lisensi [MIT](LICENSE). Bebas digunakan dan dimodifikasi untuk tujuan edukasi dan otomasi personal.
