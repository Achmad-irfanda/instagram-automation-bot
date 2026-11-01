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
 * Membersihkan folder bulan lokal jika sudah kosong (setelah file-file ter-upload)
 */
function cleanupEmptyDir(dirPath) {
    try {
        const screenshotsRoot = path.join(__dirname, 'screenshots');
        // Jangan hapus folder root 'screenshots', hanya subfoldernya saja jika kosong
        if (path.resolve(dirPath) !== path.resolve(screenshotsRoot)) {
            const files = fs.readdirSync(dirPath);
            if (files.length === 0) {
                fs.rmdirSync(dirPath);
                console.log(`   📁 Folder lokal kosong "${path.basename(dirPath)}" dibersihkan.`);
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
 * Mencari apakah folder bulan sudah ada di folder sharing Google Drive.
 * Jika belum ada, otomatis membuat folder bulan baru.
 */
async function findOrCreateMonthFolder(targetFolderName, parentFolderId = null) {
    if (!parentFolderId) parentFolderId = getParentFolderId();
    const token = await getAccessToken();

    // 1. Ambil semua folder yang ada di dalam parentFolderId
    const query = encodeURIComponent(`'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const listRes = await driveApiRequest({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files?q=${query}&fields=files(id,name,mimeType)`,
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    const existingFolders = listRes.files || [];

    // Normalisasi pencocokan nama folder
    // Contoh: "November 2024" dicocokkan dengan "november 2024", "November", atau "november"
    const targetNorm = targetFolderName.toLowerCase().trim();
    const targetMonth = targetNorm.split(' ')[0]; // Ambil kata pertama (nama bulan)

    let matchedFolder = null;

    // A. Cek kecocokan persis
    for (const folder of existingFolders) {
        const nameNorm = folder.name.toLowerCase().trim();
        if (nameNorm === targetNorm) {
            matchedFolder = folder;
            break;
        }
    }

    // B. Cek kecocokan nama bulan saja jika persis belum ketemu (misal Drive ada folder "november" atau "agustus")
    if (!matchedFolder) {
        for (const folder of existingFolders) {
            const nameNorm = folder.name.toLowerCase().trim();
            if (nameNorm === targetMonth || nameNorm.startsWith(targetMonth)) {
                matchedFolder = folder;
                break;
            }
        }
    }

    if (matchedFolder) {
        console.log(`📁 Folder Google Drive ditemukan: "${matchedFolder.name}" (ID: ${matchedFolder.id})`);
        return matchedFolder.id;
    }

    // Jika belum ada, buat folder bulan baru di dalam parentFolderId
    console.log(`📁 Folder bulan "${targetFolderName}" belum ada di Drive. Membuat folder baru...`);
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

    console.log(`✅ Berhasil membuat folder baru: "${targetFolderName}" (ID: ${createRes.id})`);
    return createRes.id;
}

/**
 * Upload satu file screenshot ke folder bulan di Google Drive.
 * Otomatis mengecek jika file dengan nama yang sama sudah pernah ter-upload.
 */
async function uploadScreenshot(filePath, folderName, parentFolderId = null) {
    if (!parentFolderId) parentFolderId = getParentFolderId();
    if (!fs.existsSync(filePath)) {
        throw new Error(`File tidak ditemukan: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const token = await getAccessToken();

    // 1. Pastikan folder bulan sudah tersedia (ambil ID yang sudah ada atau buat baru)
    const targetFolderId = await findOrCreateMonthFolder(folderName, parentFolderId);

    // 2. Cek apakah file dengan nama yang sama sudah ada di dalam folder tersebut
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
            folderName: folderName,
            folderId: targetFolderId,
            alreadyExisted: true,
            link: existing.webViewLink
        };
    }

    // 3. Upload file menggunakan multipart upload
    console.log(`☁️  Mengunggah "${fileName}" ke folder "${folderName}" di Google Drive...`);
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
        folderName: folderName,
        folderId: targetFolderId,
        alreadyExisted: false,
        link: uploadRes.webViewLink
    };
}

/**
 * Scan seluruh folder `screenshots/` dan upload semua file yang ada
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

    const entries = fs.readdirSync(screenshotsDir, { withFileTypes: true });
    let totalUploaded = 0;
    let totalSkipped = 0;

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const monthFolderName = entry.name;
            const subDirPath = path.join(screenshotsDir, monthFolderName);
            const files = fs.readdirSync(subDirPath).filter(f => f.endsWith('.png'));

            if (files.length > 0) {
                console.log(`\n--------------------------------------------------`);
                console.log(`📂 Memproses Folder Bulan: "${monthFolderName}" (${files.length} file)`);
                console.log(`--------------------------------------------------`);

                for (const file of files) {
                    const filePath = path.join(subDirPath, file);
                    try {
                        const res = await uploadScreenshot(filePath, monthFolderName);
                        if (res.alreadyExisted) totalSkipped++;
                        else totalUploaded++;
                    } catch (err) {
                        console.error(`❌ Gagal upload ${file}:`, err.message);
                    }
                }
            }
        } else if (entry.isFile() && entry.name.endsWith('.png')) {
            // File PNG langsung di root folder screenshots
            const filePath = path.join(screenshotsDir, entry.name);
            const fallbackMonth = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
            try {
                const res = await uploadScreenshot(filePath, fallbackMonth);
                if (res.alreadyExisted) totalSkipped++;
                else totalUploaded++;
            } catch (err) {
                console.error(`❌ Gagal upload ${entry.name}:`, err.message);
            }
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
    findOrCreateMonthFolder,
    uploadScreenshot,
    syncAllScreenshots
};
