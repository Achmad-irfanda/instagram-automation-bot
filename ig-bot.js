const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Memproses 1 postingan Instagram: Buka -> Deteksi Tanggal -> Like -> Komentar -> Screenshot
 */
async function processPost(page, rawUrl, commentText, screenshotsDir) {
    // Gunakan format /p/ agar kotak komentar selalu langsung tampil di sebelah kanan (bukan tersembunyi di mode Reels)
    const postUrl = rawUrl.trim().split('?')[0].replace('/reels/', '/p/').replace('/reel/', '/p/');

    let postDateISO = new Date().toISOString().split('T')[0];
    let folderName = new Date().toLocaleDateString('id-ID', {
        month: 'long',
        year: 'numeric'
    });

    console.log(`1. Membuka URL postingan: ${postUrl}`);

    // Gunakan domcontentloaded agar kerangka HTML benar-benar siap dulu
    try {
        await page.goto(postUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
    } catch (gotoErr) {
        console.log('   -> Navigasi awal lambat, lanjut menunggu elemen...');
    }

    // WAJIB tunggu sampai gambar/artikel postingan muncul di layar (maksimal 45 detik)
    console.log('   -> Menunggu halaman postingan selesai dimuat...');
    await page.waitForSelector('article, main svg[aria-label="Like"], main svg[aria-label="Suka"], time[datetime]', {
        timeout: 45000
    }).catch(() => { });

    await page.waitForTimeout(4000);

    // Tutup pop-up notifikasi jika muncul
    const notNowBtn = page.locator('button:has-text("Not Now"), button:has-text("Lain Kali")').first();
    if (await notNowBtn.isVisible().catch(() => false)) {
        await notNowBtn.click().catch(() => { });
        await page.waitForTimeout(1000);
    }

    // 📅 AMBIL TANGGAL & BULAN ASLI POSTINGAN
    const rawDatetime = await page.evaluate(() => {
        const postTimeLink = document.querySelector('a[href*="/p/"] time[datetime], a[href*="/reel/"] time[datetime]');
        if (postTimeLink) return postTimeLink.getAttribute('datetime');

        const allTimes = Array.from(document.querySelectorAll('time[datetime]'));
        if (allTimes.length > 0) {
            return allTimes[allTimes.length - 1].getAttribute('datetime');
        }
        return null;
    }).catch(() => null);

    if (rawDatetime) {
        const dObj = new Date(rawDatetime);
        if (!isNaN(dObj.getTime())) {
            postDateISO = rawDatetime.split('T')[0];
            folderName = dObj.toLocaleDateString('id-ID', {
                month: 'long',
                year: 'numeric'
            });
            console.log(`   -> Bulan postingan: ${folderName} (${postDateISO})`);
        }
    }

    // 2. KLIK TOMBOL LIKE
    console.log('2. Mencoba klik Like...');
    const alreadyLiked = page.locator('svg[aria-label="Unlike"][width="24"], svg[aria-label="Batal Suka"][width="24"]').first();

    if (await alreadyLiked.isVisible().catch(() => false)) {
        console.log('   -> Postingan sudah di-like sebelumnya.');
    } else {
        const likeSvg = page.locator('svg[aria-label="Like"][width="24"], svg[aria-label="Suka"][width="24"]').first();
        if (await likeSvg.isVisible().catch(() => false)) {
            const likeButton = likeSvg.locator('xpath=ancestor::*[@role="button" or self::button][1]');
            if (await likeButton.count() > 0) {
                await likeButton.click({ delay: 100 });
            } else {
                await likeSvg.click({ force: true });
            }
            console.log('   -> Berhasil klik Like!');
            await page.waitForTimeout(2000);
        } else {
            console.log('   -> Tombol Like tidak ditemukan (mungkin sudah disukai atau berbeda layout).');
        }
    }

    // 3. FOKUS & KETIK KOMENTAR
    console.log('3. Menyiapkan kolom komentar...');
    const commentBoxSelector = [
        'textarea[aria-label*="comment" i]',
        'textarea[placeholder*="comment" i]',
        'textarea[aria-label*="komentar" i]',
        'textarea[placeholder*="komentar" i]',
        'form textarea'
    ].join(', ');

    let commentBox = page.locator(commentBoxSelector).first();

    // Jika belum terlihat, klik ikon komentar untuk memfokuskan/membuka kotak komentar
    if (!(await commentBox.isVisible().catch(() => false))) {
        console.log('   -> Mengklik ikon Komentar agar kotak input muncul...');
        const commentSvg = page.locator('svg[aria-label="Comment"], svg[aria-label="Komentari"], svg[aria-label="Komentar"]').first();
        if (await commentSvg.isVisible().catch(() => false)) {
            const commentBtn = commentSvg.locator('xpath=ancestor::*[@role="button" or self::button][1]');
            if (await commentBtn.count() > 0) {
                await commentBtn.click();
            } else {
                await commentSvg.click({ force: true });
            }
            await page.waitForTimeout(2000);
        }
    }

    // Tunggu sampai kotak komentar benar-benar siap (maksimal 25 detik)
    await commentBox.waitFor({ state: 'visible', timeout: 25000 });
    await commentBox.scrollIntoViewIfNeeded().catch(() => { });
    await commentBox.click({ force: true });
    await page.waitForTimeout(800);

    console.log(`4. Mengetik komentar: "${commentText}"`);
    await page.keyboard.type(commentText, { delay: 70 });
    await page.waitForTimeout(1000);

    // Pastikan teks benar-benar masuk ke dalam textarea (jika belum masuk karena fokus lepas, gunakan fill)
    const currentVal = await commentBox.inputValue().catch(() => '');
    if (!currentVal || currentVal.trim().length === 0) {
        console.log('   -> Menggunakan metode fill cadangan...');
        await commentBox.fill(commentText);
        await page.waitForTimeout(1000);
    }

    // 5. KLIK TOMBOL POST / KIRIM
    console.log('5. Mengirim komentar...');
    const postBtn = page.locator('form div[role="button"], form button, div[role="button"]').filter({ hasText: /^(Post|Kirim)$/i }).first();

    if (await postBtn.isVisible().catch(() => false)) {
        await postBtn.click({ delay: 100 });
        console.log('   -> Tombol Post berhasil diklik!');
    } else {
        console.log('   -> Menekan Enter untuk mengirim komentar...');
        await commentBox.press('Enter');
    }

    // 6. TUNGGU SAMPAI KOMENTAR SELESAI TER-POSTING (KOTAK INPUT KEMBALI KOSONG)
    console.log('6. Menunggu komentar selesai ter-posting di Instagram...');
    await page.waitForFunction(
        () => {
            const ta = document.querySelector('form textarea, textarea[aria-label*="comment" i], textarea[aria-label*="komentar" i]');
            if (!ta) return false;
            return !ta.disabled && ta.value.trim() === '';
        },
        { timeout: 25000 }
    ).catch(() => {
        console.log('   -> Waktu tunggu maksimal selesai.');
    });

    // Tambahan jeda 4 detik agar komentar baru benar-benar tampil di daftar komentar sebelum dipotret
    await page.waitForTimeout(4000);

    // 7. SIMPAN SCREENSHOT BERDASARKAN BULAN POSTINGAN
    console.log(`7. Mengambil screenshot bukti ke folder: ${folderName}...`);

    // Buat folder bulan di dalam screenshots (contoh: screenshots/Oktober 2024)
    const targetDir = path.join(screenshotsDir, folderName);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Ambil shortcode unik postingan agar screenshot tidak saling menimpa
    const codeMatch = postUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
    const postCode = codeMatch ? codeMatch[1] : `post-${Date.now()}`;
    const filename = `${postDateISO}_bukti_${postCode}.png`;
    const screenshotPath = path.join(targetDir, filename);

    await page.screenshot({ path: screenshotPath });
    console.log(`   -> Screenshot tersimpan di: ${screenshotPath}`);

    return {
        status: 'success',
        file: screenshotPath,
        postDate: postDateISO,
        folderName: folderName,
        comment: commentText,
        url: postUrl
    };
}

// Mode Eksekusi Langsung dari Terminal (CLI)
if (require.main === module) {
    const rawUrl = process.argv[2];
    let commentText = process.argv[3];

    if (!rawUrl) {
        console.log('Penggunaan:');
        console.log('  Mode 1 Post:   node ig-bot.js <POST_URL> [COMMENT_TEXT]');
        console.log('  Mode Otomatis: node run-batch.js (atau node uri-comment.js)');
        process.exit(1);
    }

    // Jika komentar tidak diisi di CLI, ambil acak dari uri-comment.js jika ada
    if (!commentText) {
        try {
            const { comments } = require('./uri-comment');
            if (comments && comments.length > 0) {
                commentText = comments[Math.floor(Math.random() * comments.length)];
                console.log(`🎲 Memilih komentar acak: "${commentText}"`);
            }
        } catch (e) {
            commentText = 'Keren banget postingannya! Semangat terus!';
        }
    }

    (async () => {
        const sessionPath = path.join(__dirname, 'ig-session');
        const screenshotsDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
        }

        const context = await chromium.launchPersistentContext(sessionPath, {
            headless: false,
            viewport: { width: 1280, height: 800 },
            serviceWorkers: 'block',
            args: ['--disable-blink-features=AutomationControlled']
        });

        const page = context.pages()[0] || await context.newPage();

        try {
            const result = await processPost(page, rawUrl, commentText, screenshotsDir);
            console.log(`RESULT_JSON:${JSON.stringify(result)}`);
        } catch (err) {
            console.error('Terjadi error:', err);
            process.exit(1);
        } finally {
            await context.close();
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    })();
}

module.exports = { processPost };
