const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, 'gdrive-auth.json');
const DEFAULT_PORT = 5678;
const DEFAULT_CALLBACK_PATH = '/rest/oauth2-credential/callback';
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_PORT}${DEFAULT_CALLBACK_PATH}`;

// Cari file client_secret jika gdrive-auth.json belum ada
function findClientSecretFile() {
    const files = fs.readdirSync(__dirname);
    const clientSecretFile = files.find(f => f.startsWith('client_secret_') && f.endsWith('.json'));
    if (clientSecretFile) {
        try {
            const content = JSON.parse(fs.readFileSync(path.join(__dirname, clientSecretFile), 'utf8'));
            const creds = content.web || content.installed;
            if (creds) {
                return {
                    clientId: creds.client_id,
                    clientSecret: creds.client_secret,
                    redirectUris: creds.redirect_uris || []
                };
            }
        } catch (e) { }
    }
    return null;
}

// Ambil konfigurasi saat ini
function getCredentials() {
    let existingConfig = {};
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (e) { }
    }

    const secretFile = findClientSecretFile();

    const clientId = existingConfig.clientId || (secretFile ? secretFile.clientId : '');
    const clientSecret = existingConfig.clientSecret || (secretFile ? secretFile.clientSecret : '');
    const parentFolderId = existingConfig.parentFolderId || 'YOUR_GOOGLE_DRIVE_FOLDER_ID';

    return { clientId, clientSecret, parentFolderId, existingConfig };
}

// Buka URL di browser pengguna
function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32' ? `start "" "${url}"` :
                `xdg-open "${url}"`;
    exec(cmd, () => {});
}

// Tukar authorization code menjadi Refresh Token & Access Token
function exchangeCodeForTokens(code, clientId, clientSecret, redirectUri) {
    const postData = new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
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
                    if (json.refresh_token) {
                        resolve(json);
                    } else if (json.access_token) {
                        // Jika tidak ada refresh_token, mungkin user sudah pernah authorize tanpa prompt=consent
                        resolve(json);
                    } else {
                        reject(new Error(`Gagal tukar kode: ${body}`));
                    }
                } catch (e) {
                    reject(new Error(`Gagal parsing respon: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Simpan refresh token ke gdrive-auth.json
function saveRefreshToken(tokens, creds) {
    const newConfig = {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: tokens.refresh_token || creds.existingConfig.refreshToken,
        parentFolderId: creds.parentFolderId
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    return newConfig;
}

async function main() {
    console.log(`\n===============================================================`);
    console.log(`🔑 GOOGLE DRIVE OAUTH TOKEN GENERATOR / REFRESHER`);
    console.log(`===============================================================\n`);

    const creds = getCredentials();

    if (!creds.clientId || !creds.clientSecret) {
        console.error('❌ Error: Client ID atau Client Secret tidak ditemukan.');
        console.error(`   Pastikan file "gdrive-auth.json" atau file "client_secret_*.json" ada di folder ini.\n`);
        process.exit(1);
    }

    const redirectUri = DEFAULT_REDIRECT_URI;
    const scope = 'https://www.googleapis.com/auth/drive';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(creds.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

    console.log(`📌 Client ID    : ${creds.clientId}`);
    console.log(`📌 Redirect URI : ${redirectUri}`);
    console.log(`📌 Target Folder: ${creds.parentFolderId}\n`);

    let server;
    let serverClosed = false;

    const cleanup = () => {
        if (!serverClosed && server) {
            serverClosed = true;
            try { server.close(); } catch (e) {}
        }
    };

    const handleSuccess = (tokens) => {
        if (!tokens.refresh_token) {
            console.log(`\n⚠️ Google tidak mengembalikan refresh_token baru (mungkin sudah terdaftar).`);
            console.log(`   Pastikan parameter prompt=consent digunakan.`);
        } else {
            saveRefreshToken(tokens, creds);
            console.log(`\n🎉 SUKSES! Refresh Token baru berhasil disimpan ke gdrive-auth.json`);
            console.log(`✅ Google Drive API kini siap digunakan kembali tanpa error invalid_grant!`);
        }
        cleanup();
        setTimeout(() => process.exit(0), 1000);
    };

    // Jalankan server lokal untuk menangkap callback otomatis
    server = http.createServer(async (req, res) => {
        try {
            const reqUrl = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);
            if (reqUrl.pathname === DEFAULT_CALLBACK_PATH) {
                const code = reqUrl.searchParams.get('code');
                const error = reqUrl.searchParams.get('error');

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h2>❌ Autentikasi Dibatalkan: ${error}</h2><p>Silakan tutup tab ini dan coba lagi.</p>`);
                    console.error(`\n❌ Autentikasi ditolak oleh pengguna: ${error}`);
                    cleanup();
                    process.exit(1);
                    return;
                }

                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: #2e7d32;">✅ Autentikasi Berhasil!</h1>
                            <p style="font-size: 16px; color: #333;">Token Google Drive baru telah berhasil diperoleh dan disimpan ke <b>gdrive-auth.json</b>.</p>
                            <p style="color: #666;">Anda dapat menutup halaman ini sekarang dan kembali ke terminal.</p>
                        </div>
                    `);

                    console.log(`\n📥 Kode otorisasi diterima dari Google! Menukar kode dengan Refresh Token...`);
                    try {
                        const tokens = await exchangeCodeForTokens(code, creds.clientId, creds.clientSecret, redirectUri);
                        handleSuccess(tokens);
                    } catch (err) {
                        console.error(`❌ Gagal menukar kode otorisasi:`, err.message);
                        cleanup();
                        process.exit(1);
                    }
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`⚠️ Port ${DEFAULT_PORT} sedang digunakan (misalnya oleh n8n).`);
            console.warn(`   Server callback lokal tidak dapat berjalan otomatis di port ${DEFAULT_PORT}.`);
            console.warn(`   Anda tetap dapat login manual dengan menyalin URL di bawah.`);
        } else {
            console.error(`⚠️ Server error:`, err.message);
        }
    });

    try {
        server.listen(DEFAULT_PORT, () => {
            console.log(`🌐 Server callback lokal aktif di http://localhost:${DEFAULT_PORT}${DEFAULT_CALLBACK_PATH}`);
        });
    } catch (e) { }

    console.log(`🌐 Membuka browser untuk login Google Drive...\n`);
    console.log(`👉 Jika browser tidak terbuka otomatis, silakan buka URL ini di browser Anda:`);
    console.log(`\x1b[36m${authUrl}\x1b[0m\n`);

    openBrowser(authUrl);

    console.log(`⏳ Menunggu respon dari Google di browser...`);
    console.log(`(Atau Anda dapat menempelkan URL callback / kode dari address bar di bawah jika browser tidak otomatis redirect):\n`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Tempelkan URL callback atau Kode di sini (opsional): ', async (answer) => {
        const input = (answer || '').trim();
        if (!input) return;

        let code = input;
        try {
            if (input.includes('code=')) {
                const parsed = new URL(input.startsWith('http') ? input : `http://dummy.com/${input}`);
                code = parsed.searchParams.get('code') || input;
            }
        } catch (e) { }

        console.log(`\n📥 Kode manual dimasukkan, memproses pertukaran token...`);
        try {
            const tokens = await exchangeCodeForTokens(code, creds.clientId, creds.clientSecret, redirectUri);
            handleSuccess(tokens);
        } catch (err) {
            console.error(`❌ Gagal menukar kode:`, err.message);
            cleanup();
            process.exit(1);
        }
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
