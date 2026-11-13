const https = require('https');
const fs = require('fs');
const path = require('path');

// Konfigurasi Google Drive & GCP OAuth
const CONFIG_FILE = path.join(__dirname, 'gdrive-auth.json');

let cachedAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Memuat konfigurasi kredensial GCP
 */
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error(`File konfigurasi ${CONFIG_FILE} tidak ditemukan.`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/**
 * Mendapatkan Parent Folder ID dari file konfigurasi gdrive-auth.json
 */
function getParentFolderId() {
    try {
        const config = loadConfig();
        if (config.parentFolderId && config.parentFolderId !== 'YOUR_GOOGLE_DRIVE_FOLDER_ID') {
            return config.parentFolderId;
        }
    } catch (e) { }
    return process.env.GDRIVE_PARENT_FOLDER_ID || '1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw';
}

/**
 * Membersihkan folder-folder lokal secara rekursif jika sudah kosong (setelah file-file ter-upload)
 * Mulai dari folder tanggal -> folder akun -> folder bulan hingga batas folder 'screenshots'
 */
function cleanupEmptyDir(startDirPath) {
    try {
        const screenshotsRoot = path.resolve(__dirname, 'screenshots');
        let currentDir = path.resolve(startDirPath);

        while (currentDir !== screenshotsRoot && currentDir.startsWith(screenshotsRoot)) {
            if (fs.existsSync(currentDir)) {
                const files = fs.readdirSync(currentDir);
                if (files.length === 0) {
                    fs.rmdirSync(currentDir);
                    console.log(`   📁 Folder lokal kosong "${path.basename(currentDir)}" dibersihkan.`);
                    currentDir = path.dirname(currentDir);
                } else {
                    break; // Masih ada file atau folder lain, berhenti
                }
            } else {
                currentDir = path.dirname(currentDir);
            }
        }
    } catch (e) {
        // Abaikan jika gagal cek folder
    }
}

/**
 * Mendapatkan Access Token aktif (auto-refresh menggunakan Refresh Token)
 */
async function getAccessToken() {
    const now = Date.now();
    // Gunakan cache jika token masih valid (dengan buffer 60 detik)
    if (cachedAccessToken && now < tokenExpiryTime - 60000) {
        return cachedAccessToken;
    }

    const config = loadConfig();
    const postData = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token'
    }).toString();

    return new Promise((resolve, reject) => {
        const req = https.request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.access_token) {
                        cachedAccessToken = json.access_token;
                        tokenExpiryTime = Date.now() + (json.expires_in * 1000);
                        resolve(cachedAccessToken);
                    } else {
                        reject(new Error(`Gagal mendapatkan token: ${body}`));
                    }
                } catch (e) {
                    reject(new Error(`Gagal parsing respon token: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Request HTTP Helper untuk Google Drive API
 */
function driveApiRequest(options, postBody = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = body ? JSON.parse(body) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(`Drive API Error [${res.statusCode}]: ${json.error ? json.error.message : body}`));
                    }
                } catch (err) {
                    resolve(body);
                }
            });
        });

        req.on('error', reject);
        if (postBody) req.write(postBody);
        req.end();
    });
}

/**
 * Mengubah input hierarki folder menjadi array string terurut:
 * Contoh: [ "Oktober 2026", "interactivetech", "2026-10-30" ]
 */
function normalizeFolderChain(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map(item => String(item).trim()).filter(Boolean);
    }
    if (typeof input === 'object') {
        const chain = [];
        const month = input.month || input.folderName;
        const account = input.account || input.accountName;
        const date = input.date || input.dateFolderName || input.postDate;
        if (month) chain.push(String(month).trim());
        if (account) chain.push(String(account).trim());
        if (date) chain.push(String(date).trim());
        return chain;
    }
    if (typeof input === 'string') {
        return [input.trim()];
    }
    return [];
}

/**
 * Mencari apakah folder dengan nama tertentu sudah ada di dalam parentFolderId.
 * Jika sudah ada, mengembalikan ID-nya (reuse / tidak buat duplikat).
 * Jika belum ada, otomatis membuat folder baru.
 */
async function findOrCreateFolder(targetFolderName, parentFolderId = null) {
    if (!parentFolderId) parentFolderId = getParentFolderId();
    const token = await getAccessToken();

    // 1. Ambil semua folder yang ada di dalam parentFolderId
    const safeParent = parentFolderId.replace(/'/g, "\\'");
    const query = encodeURIComponent(`'${safeParent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const listRes = await driveApiRequest({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files?q=${query}&fields=files(id,name,mimeType)`,
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    const existingFolders = listRes.files || [];
    const targetNorm = targetFolderName.toLowerCase().trim();

    // A. Cek kecocokan persis (case-insensitive)
    for (const folder of existingFolders) {
        if (folder.name.toLowerCase().trim() === targetNorm) {
            console.log(`   📁 Folder Google Drive ditemukan: "${folder.name}" (ID: ${folder.id})`);
            return folder.id;
        }
    }

    // B. Cek kecocokan nama bulan jika format bulan (misal "Oktober 2026" vs "Oktober")
    const targetMonth = targetNorm.split(' ')[0];
    const months = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
    if (months.includes(targetMonth)) {
        for (const folder of existingFolders) {
            const nameNorm = folder.name.toLowerCase().trim();
            if (nameNorm === targetMonth || nameNorm.startsWith(targetMonth)) {
                console.log(`   📁 Folder Google Drive ditemukan (pencocokan bulan): "${folder.name}" (ID: ${folder.id})`);
                return folder.id;
            }
        }
    }

    // C. Jika belum ada, buat folder baru di dalam parentFolderId
    console.log(`   📁 Folder "${targetFolderName}" belum ada di Drive. Membuat folder baru...`);
    const createRes = await driveApiRequest({
        hostname: 'www.googleapis.com',
        path: '/drive/v3/files',
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    }, JSON.stringify({
        name: targetFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
    }));

    console.log(`   ✅ Berhasil membuat folder: "${targetFolderName}" (ID: ${createRes.id})`);
    return createRes.id;
}

/**
 * Backward-compatibility helper untuk folder bulan
 */
async function findOrCreateMonthFolder(targetFolderName, parentFolderId = null) {
    if (!parentFolderId) parentFolderId = getParentFolderId();
    return await findOrCreateFolder(targetFolderName, parentFolderId);
}

/**
 * Upload satu file screenshot ke hierarki folder bertingkat di Google Drive:
 * Level 1: Bulan & Tahun
 * Level 2: ID Akun Instagram
 * Level 3: Tanggal Postingan
 *
 * Otomatis mengecek jika file dengan nama yang sama sudah pernah ter-upload.
 */
async function uploadScreenshot(filePath, folderHierarchy, parentFolderId = null) {
    if (!parentFolderId) parentFolderId = getParentFolderId();
    if (!fs.existsSync(filePath)) {
        throw new Error(`File tidak ditemukan: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const token = await getAccessToken();

    // 1. Buat / telusuri rantai folder bertingkat (Bulan -> Akun -> Tanggal)
    const folderChain = normalizeFolderChain(folderHierarchy);
    let targetFolderId = parentFolderId;
    let pathDisplay = [];

    for (const folderName of folderChain) {
        targetFolderId = await findOrCreateFolder(folderName, targetFolderId);
        pathDisplay.push(folderName);
    }

    const folderPathText = pathDisplay.join(' / ') || 'Root';

    // 2. Cek apakah file dengan nama yang sama sudah ada di dalam folder tujuan tersebut
    const checkFileQuery = encodeURIComponent(`'${targetFolderId}' in parents and name = '${fileName}' and trashed = false`);
    const fileListRes = await driveApiRequest({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files?q=${checkFileQuery}&fields=files(id,name,webViewLink)`,
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (fileListRes.files && fileListRes.files.length > 0) {
        const existing = fileListRes.files[0];
        console.log(`ℹ️  File "${fileName}" sudah ada di Google Drive (ID: ${existing.id}), melewati upload.`);
        // Hapus file lokal karena sudah aman tersimpan di Google Drive
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`   🗑️  File lokal "${fileName}" dihapus untuk menghemat ruang disk.`);
                cleanupEmptyDir(path.dirname(filePath));
            }
        } catch (delErr) {
            console.log(`   ⚠️ Gagal menghapus file lokal: ${delErr.message}`);
        }
        return {
            id: existing.id,
            fileName: fileName,
            folderPath: folderPathText,
            folderId: targetFolderId,
            alreadyExisted: true,
            link: existing.webViewLink
        };
    }

    // 3. Upload file menggunakan multipart upload
    console.log(`☁️  Mengunggah "${fileName}" ke [${folderPathText}] di Google Drive...`);
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '-------GoogleDriveUploadBoundary' + Date.now();

    const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
        name: fileName,
        parents: [targetFolderId]
    })}\r\n`;

    const mediaHeader = `--${boundary}\r\nContent-Type: image/png\r\n\r\n`;
    const closingPart = `\r\n--${boundary}--`;

    const bodyBuffer = Buffer.concat([
        Buffer.from(metadataPart, 'utf8'),
        Buffer.from(mediaHeader, 'utf8'),
        fileBuffer,
        Buffer.from(closingPart, 'utf8')
    ]);

    const uploadRes = await driveApiRequest({
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': bodyBuffer.length
        }
    }, bodyBuffer);

    console.log(`🎉 Berhasil ter-upload! File ID: ${uploadRes.id}`);

    // Hapus file lokal setelah berhasil di-upload ke Google Drive
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`   🗑️  File lokal "${fileName}" berhasil dihapus dari komputer.`);
            cleanupEmptyDir(path.dirname(filePath));
        }
    } catch (delErr) {
        console.log(`   ⚠️ Gagal menghapus file lokal: ${delErr.message}`);
    }
    return {
        id: uploadRes.id,
        fileName: fileName,
        folderPath: folderPathText,
        folderId: targetFolderId,
        alreadyExisted: false,
        link: uploadRes.webViewLink
    };
}

/**
 * Mencari seluruh file screenshot di direktori screenshots/ beserta hierarki subfoldernya
 */
function getAllScreenshotFiles(dirPath, rootDir = null) {
    if (!rootDir) rootDir = dirPath;
    let results = [];
    if (!fs.existsSync(dirPath)) return results;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            results = results.concat(getAllScreenshotFiles(fullPath, rootDir));
        } else if (entry.isFile() && entry.name.endsWith('.png')) {
            const relPath = path.relative(rootDir, fullPath);
            const pathParts = relPath.split(path.sep);
            const folderChain = pathParts.slice(0, -1);
            results.push({
                filePath: fullPath,
                fileName: entry.name,
                folderChain: folderChain.length > 0 ? folderChain : [new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })]
            });
        }
    }
    return results;
}

/**
 * Scan seluruh folder `screenshots/` dan upload semua file yang ada sesuai hierarki foldernya
 */
async function syncAllScreenshots() {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        console.log('⚠️ Direktori screenshots/ belum ada.');
        return;
    }

    const parentFolderId = getParentFolderId();
    console.log(`\n🚀 SINKRONISASI SCREENSHOT KE GOOGLE DRIVE`);
    console.log(`📂 Folder tujuan utama ID: ${parentFolderId}\n`);

    const items = getAllScreenshotFiles(screenshotsDir);
    let totalUploaded = 0;
    let totalSkipped = 0;

    if (items.length === 0) {
        console.log('ℹ️  Tidak ada file screenshot lokal yang ditemukan untuk disinkronkan.');
        return;
    }

    console.log(`📋 Ditemukan ${items.length} file screenshot lokal untuk disinkronkan.\n`);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        console.log(`--------------------------------------------------`);
        console.log(`[${i + 1}/${items.length}] Memproses file: ${item.fileName}`);
        console.log(`   Hierarki: ${item.folderChain.join(' -> ')}`);
        try {
            const res = await uploadScreenshot(item.filePath, item.folderChain, parentFolderId);
            if (res.alreadyExisted) totalSkipped++;
            else totalUploaded++;
        } catch (err) {
            console.error(`❌ Gagal upload ${item.fileName}:`, err.message);
        }
    }

    console.log(`\n==================================================`);
    console.log(`🏁 SINKRONISASI SELESAI!`);
    console.log(`📊 Upload Baru: ${totalUploaded} | Sudah Ada (Lewati): ${totalSkipped}`);
    console.log(`==================================================\n`);
}

// Mode Eksekusi CLI: node google-drive.js
if (require.main === module) {
    syncAllScreenshots().catch(err => {
        console.error('Fatal error saat sinkronisasi Google Drive:', err);
    });
}

module.exports = {
    getAccessToken,
    findOrCreateFolder,
    findOrCreateMonthFolder,
    uploadScreenshot,
    syncAllScreenshots
};
