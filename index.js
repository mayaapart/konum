// Gerekli paketleri içe aktarma
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Railway için kalıcı depolama yolu ayarla
const AUTH_FOLDER = process.env.RAILWAY_STATIC_URL ? '/data/auth_info' : './auth_info';

// Klasör yoksa oluştur
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    console.log(`Auth klasörü oluşturuldu: ${AUTH_FOLDER}`);
}

// Bot ayarları
const LOCATION_TRIGGER_WORDS = ['konum', 'lokasyon', 'nerede', 'adres', 'location', 'where']; // Farklı dillerde tetikleyici kelimeler
const LOCATION_DATA = {
    latitude: 39.92381451790397,
    longitude: 32.82544004031294,
    // İsterseniz buraya otel adı ekleyebilirsiniz
    // name: "Otel Adı"
};

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
                printQRInTerminal: true, // Terminal'de QR kodu gösterme
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
            sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                // QR kodu görüntülendiğinde
                if (qr) {
                    console.log('\n\n');
                    console.log('=================== QR KOD ===================');
                    console.log('QR KODU WHATSAPP\'TA TARAYIN:');
                    // QR kodu terminal'de görüntüle
                    qrcode.generate(qr, { small: true });
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
                        // Railway'de process.exit() kullanmayın, bunun yerine yeniden deneyin
                        setTimeout(connectToWhatsApp, 30000);
                    }
                } else if (connection === 'open') {
                    console.log('\n\n');
                    console.log('====================================');
                    console.log('| WhatsApp Konum Botu aktif!       |');
                    console.log('| "Konum" içeren mesajları dinliyor |');
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
                console.log(`[${dateStr} ${timeStr}] Tetikleyici algılandı! Konum gönderiliyor: ${sender}`);
                
                // Konum gönder
                await sock.sendMessage(message.key.remoteJid, { 
                    location: { 
                        degreesLatitude: LOCATION_DATA.latitude,
                        degreesLongitude: LOCATION_DATA.longitude,
                        name: LOCATION_DATA.name // İsteğe bağlı
                    } 
                });
                
                console.log(`[${dateStr} ${timeStr}] Konum gönderildi: ${sender}`);
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

// Botu çalıştır
startWhatsAppBot();
