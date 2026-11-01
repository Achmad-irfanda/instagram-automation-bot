const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { comments, urlPost } = require('./uri-comment');
const { processPost } = require('./ig-bot');
const { uploadScreenshot } = require('./google-drive');

// Jeda aman (dalam detik) antar postingan agar akun tidak terkena spam detection Instagram
const MIN_DELAY_SECONDS = 10;
const MAX_DELAY_SECONDS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = (minSec, maxSec) => Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;

// Fungsi memilih komentar acak dari list tanpa duplikat jika memungkinkan
function pickRandomComment(list, usedSet) {
    if (!list || list.length === 0) return 'Keren banget postingannya! 🔥';
    const unused = list.filter(c => !usedSet.has(c));
    const pool = unused.length > 0 ? unused : list;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    usedSet.add(chosen);
    return chosen;
}

(async () => {
    if (!urlPost || urlPost.length === 0) {
        console.log('⚠️ Daftar urlPost di uri-comment.js masih kosong! Silakan tambahkan URL terlebih dahulu.');
        process.exit(1);
    }

    console.log(`\n===============================================================`);
    console.log(`🚀 MEMULAI OTOMASI INSTAGRAM BATCH`);
    console.log(`📋 Total URL postingan: ${urlPost.length}`);
    console.log(`💬 Total variasi komentar: ${comments ? comments.length : 0}`);
    console.log(`⏱️  Jeda antar postingan: ${MIN_DELAY_SECONDS} - ${MAX_DELAY_SECONDS} detik`);
    console.log(`===============================================================\n`);

    const sessionPath = path.join(__dirname, 'ig-session');
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    // Buka browser satu kali untuk seluruh sesi agar cepat dan efisien
    const context = await chromium.launchPersistentContext(sessionPath, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block',
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = context.pages()[0] || await context.newPage();
    const usedComments = new Set();
    const summary = [];

    for (let i = 0; i < urlPost.length; i++) {
        const rawUrl = urlPost[i];
        const comment = pickRandomComment(comments, usedComments);

        console.log(`\n---------------------------------------------------------------`);
        console.log(`▶️ [${i + 1}/${urlPost.length}] Memproses Postingan:`);
        console.log(`   URL      : ${rawUrl}`);
        console.log(`   Komentar : "${comment}"`);
        console.log(`---------------------------------------------------------------`);

        try {
            const res = await processPost(page, rawUrl, comment, screenshotsDir);
            summary.push({
                index: i + 1,
                url: rawUrl,
                status: 'SUKSES',
                folder: res.folderName,
                screenshot: res.file
            });
            console.log(`✅ [${i + 1}/${urlPost.length}] Sukses selesai!`);

            // Upload otomatis ke Google Drive pada folder bulan yang sesuai
            try {
                const driveRes = await uploadScreenshot(res.file, res.folderName);
                if (driveRes.alreadyExisted) {
                    console.log(`   ℹ️ [Drive] File sudah ada di Google Drive (Dilewati).`);
                } else {
                    console.log(`   ☁️ [Drive] Berhasil upload ke Google Drive! Link: ${driveRes.link || driveRes.id}`);
                }
            } catch (driveErr) {
                console.log(`   ⚠️ [Drive] Gagal upload ke Drive: ${driveErr.message}`);
            }
        } catch (err) {
            console.error(`❌ [${i + 1}/${urlPost.length}] Terjadi kesalahan pada URL ini:`, err.message || err);
            summary.push({
                index: i + 1,
                url: rawUrl,
                status: 'GAGAL',
                error: err.message || 'Error tidak diketahui'
            });
        }

        // Jika masih ada postingan berikutnya, beri jeda aman
        if (i < urlPost.length - 1) {
            const delayMs = getRandomDelay(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
            console.log(`\n⏳ Menunggu jeda aman ${(delayMs / 1000).toFixed(0)} detik sebelum lanjut ke URL berikutnya...`);
            await sleep(delayMs);
        }
    }

    // Ringkasan hasil akhir
    console.log(`\n===============================================================`);
    console.log(`🎉 SEMUA POSTINGAN TELAH SELESAI DIPROSES!`);
    console.log(`📊 Total: ${urlPost.length} | Berhasil: ${summary.filter(s => s.status === 'SUKSES').length} | Gagal: ${summary.filter(s => s.status === 'GAGAL').length}`);
    console.log(`===============================================================\n`);

    await context.close();
    await sleep(2000);
})();
