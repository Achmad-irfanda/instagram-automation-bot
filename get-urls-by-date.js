const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const targetUsername = process.argv[2] || 'interactivetech';
const startDateStr = process.argv[3]; // Format: YYYY-MM-DD
const endDateStr = process.argv[4];   // Format: YYYY-MM-DD
const autoRun = process.argv.includes('--run') || process.argv.includes('-r');

if (!startDateStr || !endDateStr) {
    console.error('Usage: node get-urls-by-date.js <USERNAME> <START_DATE> <END_DATE> [--run]');
    process.exit(1);
}

const startDate = new Date(`${startDateStr}T00:00:00Z`);
const endDate = new Date(`${endDateStr}T23:59:59Z`);

(async () => {
    const sessionPath = path.join(__dirname, 'ig-session');
    const context = await chromium.launchPersistentContext(sessionPath, {
        headless: false,
        viewport: { width: 1280, height: 800 }
    });

    const page = context.pages()[0] || await context.newPage();
    let apiPosts = new Map();
    let collectedData = [];

    // 1. SADAP KHUSUS ENDPOINT DATA INSTAGRAM (Ringan & Tidak Bikin Browser Hang)
    page.on('response', async (response) => {
        const url = response.url();
        // Hanya periksa URL yang pasti berisi data JSON daftar postingan profil dan abaikan timeline/beranda
        if (!url.includes('graphql') && !url.includes('/api/v1/feed/')) return;
        if (url.includes('/api/v1/feed/timeline/') || url.includes('reels_tray') || url.includes('/api/v1/feed/stories/')) return;

        try {
            const json = await response.json();
            const findPosts = (obj, parentOwner = null) => {
                if (!obj || typeof obj !== 'object') return;

                let currentOwner = parentOwner;
                if (obj.user && obj.user.username) {
                    currentOwner = obj.user.username;
                } else if (obj.owner && obj.owner.username) {
                    currentOwner = obj.owner.username;
                }

                const code = obj.shortcode || obj.code;
                const timestamp = obj.taken_at_timestamp || obj.taken_at || (obj.caption && obj.caption.created_at);

                if (code && timestamp && typeof code === 'string' && code.length >= 8 && code.length <= 15 && typeof timestamp === 'number') {
                    if (obj.media_type || obj.display_url || obj.image_versions2 || obj.carousel_media || obj.video_versions || obj.__typename) {
                        // Filter kepemilikan postingan: jika ada username pembuat, wajib cocok dengan targetUsername!
                        const targetNorm = targetUsername.toLowerCase().trim();
                        const ownerNorm = currentOwner ? currentOwner.toLowerCase().trim() : null;

                        // Abaikan jika postingan terdeteksi milik akun lain (misal suggested post / iklan)
                        if (ownerNorm && ownerNorm !== targetNorm) return;

                        const postDate = new Date(timestamp * 1000);
                        const dateStr = postDate.toISOString().split('T')[0];
                        const postUrl = `https://www.instagram.com/p/${code}/`;
                        if (!apiPosts.has(code)) {
                            apiPosts.set(code, { url: postUrl, date: dateStr, postDate, owner: ownerNorm || targetUsername });
                        }
                    }
                }

                for (const key in obj) {
                    findPosts(obj[key], currentOwner);
                }
            };
            findPosts(json);
        } catch (e) {
            // Abaikan jika gagal parse JSON
        }
    });

    try {
        console.log(`Membuka profil @${targetUsername}...`);

        // Gunakan 'commit' + try-catch agar TIDAK AKAN PERNAH mati karena TimeoutError
        try {
            await page.goto(`https://www.instagram.com/${targetUsername}/`, {
                waitUntil: 'commit',
                timeout: 45000
            });
        } catch (gotoErr) {
            console.log('⚠️ Navigasi awal agak lambat, tapi tetap lanjut menunggu elemen...');
        }

        console.log('Menunggu 12 postingan pertama muncul di layar...');
        for (let wait = 0; wait < 30; wait++) {
            const linkCount = await page.$$eval('main a[href*="/p/"], main a[href*="/reel/"]', el => el.length).catch(() => 0);
            if (linkCount > 0) break;
            await page.waitForTimeout(2000);
        }
        await page.waitForTimeout(3000);

        console.log(`Grid profil berhasil dimuat! Mulai melakukan scrolling...`);

        let scrollAttempts = 0;
        const maxScrolls = 20;
        let stuckCount = 0;
        let lastDomCount = 0;
        let allDomUrls = new Set();

        while (scrollAttempts < maxScrolls) {
            scrollAttempts++;

            // Kumpulkan juga link dari DOM layar sebagai cadangan jika API cuma dapat 12
            const hrefs = await page.$$eval('main a[href*="/p/"], main a[href*="/reel/"]', links =>
                links.map(el => el.href)
            ).catch(() => []);
            hrefs.forEach(u => allDomUrls.add(u));

            const postsArray = Array.from(apiPosts.values());
            const nonPinnedPosts = postsArray.slice(3);
            let oldestNonPinnedDate = null;
            let oldPostsCount = 0;

            for (const item of nonPinnedPosts) {
                if (!oldestNonPinnedDate || item.postDate < oldestNonPinnedDate) {
                    oldestNonPinnedDate = item.postDate;
                }
                if (item.postDate < startDate) {
                    oldPostsCount++;
                }
            }

            const oldestStr = oldestNonPinnedDate ? oldestNonPinnedDate.toISOString().split('T')[0] : 'belum ada';
            console.log(`Scroll ke-${scrollAttempts}: Terkumpul ${apiPosts.size} data API | Total link layar: ${allDomUrls.size} | Tertua: ${oldestStr}`);

            if (oldPostsCount >= 2) {
                console.log(`-> Sudah melewati batas tanggal awal (${startDateStr}), menghentikan scroll!`);
                break;
            }

            // Jika baik API maupun link di layar sudah mencapai >= 36 post (cukup untuk 1 bulan), kita juga bisa berhenti
            if (allDomUrls.size === lastDomCount && apiPosts.size <= 12 && scrollAttempts > 5) {
                stuckCount++;
                if (stuckCount >= 4) {
                    console.log('-> Scroll selesai.');
                    break;
                }
            } else {
                stuckCount = 0;
                lastDomCount = allDomUrls.size;
            }

            // Scroll ke elemen postingan paling bawah di layar
            await page.evaluate(() => {
                const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
                if (links.length > 0) {
                    links[links.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                window.scrollBy(0, 800);
            }).catch(() => { });

            await page.waitForTimeout(3500);
        }

        // 2. JIKA ADA LINK DI LAYAR YANG BELUM TERTANGKAP TANGGALNYA OLEH API (Misal API mentok di 12 tapi layar dapat 36)
        const domUrlArray = Array.from(allDomUrls);
        if (domUrlArray.length > apiPosts.size) {
            console.log(`\nMelengkapi pengecekan tanggal untuk link yang belum masuk API...`);
            let consecutiveOld = 0;

            for (let i = 0; i < domUrlArray.length; i++) {
                const postUrl = domUrlArray[i];
                // Cek kode shortcode dari URL
                const match = postUrl.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)/);
                const code = match ? match[2] : null;

                // Kalau sudah ada di apiPosts (seperti 12 post pertama tadi), TIDAK PERLU dibuka lagi! Hemat waktu!
                if (code && apiPosts.has(code)) {
                    const knownItem = apiPosts.get(code);
                    console.log(`[Sudah di-cache API] ${postUrl} -> Tanggal: ${knownItem.date}`);
                    if (knownItem.postDate < startDate && i >= 3) {
                        consecutiveOld++;
                        if (consecutiveOld >= 2) break;
                    }
                    continue;
                }

                // Kalau belum ada di cache API, buka sebentar untuk ambil author & datetime
                try {
                    await page.goto(postUrl, { waitUntil: 'commit', timeout: 25000 });
                    await page.waitForSelector('time[datetime]', { timeout: 10000 });

                    const postInfo = await page.evaluate(() => {
                        let author = null;
                        const headerAuthor = document.querySelector('header a[role="link"], article header a');
                        if (headerAuthor) {
                            const href = headerAuthor.getAttribute('href');
                            if (href) {
                                const clean = href.replace(/^\/+|\/+$/g, '').split('/')[0].split('?')[0];
                                const blacklist = ['explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'reel'];
                                if (clean && !blacklist.includes(clean.toLowerCase())) {
                                    author = clean;
                                }
                            }
                            if (!author && headerAuthor.textContent) {
                                const text = headerAuthor.textContent.trim();
                                if (text && !text.includes(' ') && text.length <= 30) {
                                    author = text;
                                }
                            }
                        }
                        if (!author) {
                            const ogTitle = document.querySelector('meta[property="og:title"]');
                            if (ogTitle) {
                                const content = ogTitle.getAttribute('content') || '';
                                const match = content.match(/^([^•|:(@\n]+?)(?:\s+on Instagram|\s*\()/i);
                                if (match && match[1]) {
                                    const candidate = match[1].trim();
                                    if (!candidate.includes(' ') && candidate.length <= 30) {
                                        author = candidate;
                                    }
                                }
                            }
                        }

                        let datetime = null;
                        const postTimeLink = document.querySelector('a[href*="/p/"] time[datetime], a[href*="/reel/"] time[datetime]');
                        if (postTimeLink) {
                            datetime = postTimeLink.getAttribute('datetime');
                        } else {
                            const allTimes = Array.from(document.querySelectorAll('time[datetime]'));
                            if (allTimes.length > 0) {
                                datetime = allTimes[allTimes.length - 1].getAttribute('datetime');
                            }
                        }
                        return { author, datetime };
                    });

                    if (postInfo && postInfo.datetime && code) {
                        const postDate = new Date(postInfo.datetime);
                        const dateStr = postInfo.datetime.split('T')[0];
                        const targetNorm = targetUsername.toLowerCase().trim();
                        const authorNorm = postInfo.author ? postInfo.author.toLowerCase().trim() : null;

                        // Verifikasi ketat kepemilikan postingan! Jika milik akun lain (misal suggested post), abaikan!
                        if (authorNorm && authorNorm !== targetNorm) {
                            console.log(`[Cek Manual ${i + 1}/${domUrlArray.length}] ⏭️ Melewati ${postUrl} (Milik @${postInfo.author}, bukan @${targetUsername})`);
                            continue;
                        }

                        console.log(`[Cek Manual ${i + 1}/${domUrlArray.length}] ${postUrl} -> Tanggal: ${dateStr} (@${postInfo.author || targetUsername})`);
                        apiPosts.set(code, { url: postUrl, date: dateStr, postDate, owner: postInfo.author || targetUsername });

                        if (postDate < startDate && i >= 3) {
                            consecutiveOld++;
                            if (consecutiveOld >= 2) {
                                console.log('-> Sudah melewati batas tanggal awal, berhenti mengecek!');
                                break;
                            }
                        } else {
                            consecutiveOld = 0;
                        }
                    }
                } catch (e) {
                    console.log(`Gagal mengecek: ${postUrl}`);
                }
            }
        }

        // 3. FILTER HASIL AKHIR SESUAI TANGGAL & VERIFIKASI AKUN TARGET
        collectedData = [];
        const targetNorm = targetUsername.toLowerCase().trim();
        console.log(`\nMemfilter total ${apiPosts.size} postingan untuk rentang ${startDateStr} s/d ${endDateStr}...`);

        for (const item of apiPosts.values()) {
            const ownerNorm = item.owner ? item.owner.toLowerCase().trim() : targetNorm;
            // Cegah akun lain lolos
            if (ownerNorm !== targetNorm) continue;

            if (item.postDate >= startDate && item.postDate <= endDate) {
                console.log(`✅ COCOK: ${item.url} -> Tanggal: ${item.date} (@${item.owner})`);
                collectedData.push({ url: item.url, date: item.date, account: targetUsername });
            }
        }

        const outputPath = path.join(__dirname, 'posts-by-date.json');
        fs.writeFileSync(outputPath, JSON.stringify(collectedData, null, 2));

        console.log(`\n🎉 Selesai! Berhasil menyimpan ${collectedData.length} postingan ke:`);
        console.log(`   ${outputPath}`);

        // 4. OTOMATIS INSERT / RESET KE uri-comment.js
        const uriCommentPath = path.join(__dirname, 'uri-comment.js');
        if (fs.existsSync(uriCommentPath)) {
            let content = fs.readFileSync(uriCommentPath, 'utf8');
            const urlsFormatted = collectedData.map(item => `  "${item.url}"`).join(',\n');
            const newUrlPostBlock = collectedData.length > 0
                ? `const urlPost = [\n${urlsFormatted}\n];`
                : `const urlPost = [\n\n];`;
            content = content.replace(/const urlPost\s*=\s*\[[\s\S]*?\];/g, newUrlPostBlock);
            fs.writeFileSync(uriCommentPath, content, 'utf8');

            if (collectedData.length > 0) {
                console.log(`\n📝 [Auto-Insert] Berhasil memasukkan ${collectedData.length} URL ke dalam 'urlPost' di uri-comment.js!`);
            } else {
                console.log(`\n⚠️ Tidak ada postingan dari @${targetUsername} yang cocok dalam rentang ${startDateStr} s/d ${endDateStr}.`);
                console.log(`   🧹 Daftar 'urlPost' di uri-comment.js telah dikosongkan agar tidak mengeksekusi postingan lama.`);
            }
        }

    } catch (err) {
        console.error('Error saat crawling:', err);
    } finally {
        await context.close();
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 5. OTOMATIS JALANKAN EKSEKUSI JIKA PARAMETER --run DIGUNAKAN
    if (autoRun) {
        if (collectedData && collectedData.length > 0) {
            console.log(`\n===============================================================`);
            console.log(`🚀 [Auto-Run] Memulai eksekusi otomatis postingan yang baru di-crawl...`);
            console.log(`👤 Target Akun: @${targetUsername}`);
            console.log(`===============================================================\n`);
            const { spawnSync } = require('child_process');
            spawnSync('node', [path.join(__dirname, 'run-batch.js'), targetUsername], { stdio: 'inherit' });
        } else {
            console.log(`\n🛑 [Auto-Run Dibatalkan] Tidak ada postingan yang ditemukan dari @${targetUsername} untuk rentang tanggal tersebut.`);
        }
    } else if (!autoRun && collectedData && collectedData.length > 0) {
        console.log(`\n💡 Ingin langsung like, komen, & upload ke Drive otomatis setelah crawling?`);
        console.log(`   Tambahkan parameter '--run' di akhir perintah:`);
        console.log(`   👉 node get-urls-by-date.js ${targetUsername} ${startDateStr} ${endDateStr} --run\n`);
        console.log(`   Atau jalankan sekarang secara manual dengan:`);
        console.log(`   👉 node run-batch.js\n`);
    }
})();