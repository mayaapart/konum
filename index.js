// Gerekli paketleri içe aktarma
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const http = require('http');

// Basit klasör kontrolü
const AUTH_FOLDER = './auth_info';
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    console.log(`Auth klasörü oluşturuldu: ${AUTH_FOLDER}`);
}

// QR kodu URL formatına çevirme
async function qrCodeToDataURL(qrCode) {
    try {
        // QR kodu base64 formatında URL'ye çevir
        const url = await qrcode.toDataURL(qrCode);
        return url;
    } catch (error) {
        console.error("QR kod URL'ye çevrilemedi:", error);
        return null;
    }
}

// Bot ayarları
const LOCATION_TRIGGER_WORDS = ['konum', 'konun', 'knm', 'location', 'konm', 'knum']; // Farklı dillerde tetikleyici kelimeler
const LOCATION_DATA = {
    latitude: 39.923161147928354,
    longitude: 32.8254621742704,
};
const DELAY_TIME = 10000; // 10 saniye gecikme (milisaniye cinsinden)

// WhatsApp botu başlat
async function startWhatsAppBot() {
    // Bağlantı zamanını takip et (yeniden bağlanma gecikmesi için)
    let lastConnectionTime = 0;
    
    // Bağlantı fonksiyonu
    async function connectToWhatsApp() {
        // Çok sık yeniden bağlanmayı önle
        const now = Date.now();
        if (now - lastConnectionTime < 10000) {
            const waitTime = 10000 - (now - lastConnectionTime);
            console.log(`Çok sık yeniden bağlanma önleniyor. ${waitTime}ms bekleniyor...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        lastConnectionTime = Date.now();
        
        try {
            // Oturum bilgilerini yükle
            const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
            
            // WhatsApp'a bağlan
            const sock = makeWASocket({
                printQRInTerminal: false, // Terminal'de QR kodu göstermeyi kapat
                auth: state,
                browser: ['Otel Konum Bot', 'Chrome', '10.0'],
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000 // Bağlantıyı canlı tutmak için ping gönder
            });
            
            // Oturum bilgilerini kaydet
            sock.ev.on('creds.update', saveCreds);
            
            // Gelen mesajları dinle
            sock.ev.on('messages.upsert', async ({ messages }) => {
                for (const message of messages) {
                    if (message.key.fromMe) continue; // Kendi mesajlarımızı atlıyoruz
                    
                    // Mesaj işleme
                    try {
                        await handleIncomingMessage(sock, message);
                    } catch (error) {
                        console.error('Mesaj işleme hatası:', error);
                    }
                }
            });
            
            // Bağlantı durumunu dinle
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                // QR kodu görüntülendiğinde
                if (qr) {
                    console.log('\n\n');
                    console.log('=================== QR KOD ===================');
                    console.log('QR KODU WHATSAPP\'TA TARAYIN:');
                    
                    // QR kodu URL formatına çevir
                    const qrUrl = await qrCodeToDataURL(qr);
                    
                    if (qrUrl) {
                        console.log('QR Kod URL:', qrUrl);
                        console.log('\nBu URL\'yi tarayıcınızda açın ve görüntülenen QR kodu tarayın');
                    } else {
                        console.log('QR kod URL olarak oluşturulamadı, lütfen tekrar deneyin.');
                    }
                    
                    console.log('==============================================');
                    console.log('\n\n');
                }
                
                // Bağlantı durumunu kontrol et
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    console.log(`Bağlantı kapandı. Durum kodu: ${statusCode}`);
                    
                    if (shouldReconnect) {
                        console.log('Yeniden bağlanılıyor...');
                        connectToWhatsApp();
                    } else {
                        console.log('Oturum sonlandırıldı. Tekrar başlatılıyor...');
                        setTimeout(connectToWhatsApp, 30000);
                    }
                } else if (connection === 'open') {
                    console.log('\n\n');
                    console.log('====================================');
                    console.log('| WhatsApp Konum Botu aktif!       |');
                    console.log(`| 10 saniye gecikmeyle konum gönderiyor |`);
                    console.log('====================================');
                    console.log('\n');
                }
            });
        } catch (error) {
            console.error('Bağlantı kurulurken hata oluştu:', error);
            // Hata durumunda yeniden dene
            setTimeout(connectToWhatsApp, 30000);
        }
    }
    
    // Gelen mesajları işleme
    async function handleIncomingMessage(sock, message) {
        try {
            // Mesaj içeriğini al
            const messageContent = message.message?.conversation || 
                                   message.message?.extendedTextMessage?.text || 
                                   '';
            
            if (!messageContent) return; // Mesaj içeriği yoksa atla
            
            // Gönderen numarayı al
            let sender = message.key.remoteJid;
            
            // Grup mesajlarını atla
            if (sender.includes('@g.us')) return;
            
            // JID formatını temizle
            sender = sender.replace('@s.whatsapp.net', '');
            
            // Tarih ve saat bilgisi
            const now = new Date();
            const timeStr = now.toLocaleTimeString();
            const dateStr = now.toLocaleDateString();
            
            console.log(`[${dateStr} ${timeStr}] Mesaj: "${messageContent}" - Gönderen: ${sender}`);
            
            // Tetikleyici kelimeleri kontrol et
            const hasLocationTrigger = LOCATION_TRIGGER_WORDS.some(word => 
                messageContent.toLowerCase().includes(word)
            );
            
            if (hasLocationTrigger) {
                console.log(`[${dateStr} ${timeStr}] Tetikleyici algılandı! 10 saniye sonra konum gönderilecek: ${sender}`);
                
                // 10 saniye bekle ve sonra konum gönder
                setTimeout(async () => {
                    try {
                        // Konum gönder
                        await sock.sendMessage(message.key.remoteJid, { 
                            location: { 
                                degreesLatitude: LOCATION_DATA.latitude,
                                degreesLongitude: LOCATION_DATA.longitude
                            } 
                        });
                        
                        // Tarih ve saat bilgisini güncelle
                        const sendTime = new Date();
                        const sendTimeStr = sendTime.toLocaleTimeString();
                        const sendDateStr = sendTime.toLocaleDateString();
                        
                        console.log(`[${sendDateStr} ${sendTimeStr}] 10 saniye sonra konum gönderildi: ${sender}`);
                    } catch (error) {
                        console.error('Konum gönderilirken hata oluştu:', error);
                    }
                }, DELAY_TIME);
            }
        } catch (error) {
            console.error('Mesaj işlenirken hata oluştu:', error);
        }
    }
    
    // Hata yönetimi
    process.on('uncaughtException', (err) => {
        console.error('Yakalanmamış Hata:', err);
        // Kritik hatalarda yeniden başlat
        setTimeout(connectToWhatsApp, 30000);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('İşlenmeyen Promise Reddi:', reason);
    });
    
    // Botu başlat
    console.log('WhatsApp Konum Bot başlatılıyor...');
    connectToWhatsApp();
}

// HTTP sunucusu oluştur (Railway için gerekli)
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>WhatsApp Konum Botu Çalışıyor</h1>');
});

server.listen(PORT, () => {
    console.log(`Server ${PORT} portunda çalışıyor`);
    // Botu çalıştır
    startWhatsAppBot();
});
