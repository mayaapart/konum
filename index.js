// Gerekli paketleri içe aktarma
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Basit klasör kontrolü
const AUTH_FOLDER = './auth_info';
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    console.log(`Auth klasörü oluşturuldu: ${AUTH_FOLDER}`);
}

// Bağlantı durumunu izlemek için global değişken
let connectionStatus = {
    qrShown: false,              // QR kodunun gösterilip gösterilmediği
    reconnectCount: 0,           // Yeniden bağlanma sayısı
    lastConnectionTime: 0,       // Son bağlantı zamanı
    isAuthenticated: false       // Kimlik doğrulama durumu
};

// Oturum bilgisini izlemek için global değişken
let sessionFileExists = false;

// Bot ayarları
const LOCATION_TRIGGER_WORDS = ['konum', 'lokasyon', 'nerede', 'adres', 'location', 'where']; // Farklı dillerde tetikleyici kelimeler
const LOCATION_DATA = {
    latitude: 39.92381451790397,
    longitude: 32.82544004031294
};

// WhatsApp botu başlat
async function startWhatsAppBot() {
    // Oturum dosyası var mı kontrol et
    try {
        const files = fs.readdirSync(AUTH_FOLDER);
        sessionFileExists = files.length > 0;
        
        if (sessionFileExists) {
            console.log('Mevcut oturum bilgisi bulundu. QR kodu gösterilmeyecek.');
        } else {
            console.log('Oturum bilgisi bulunamadı. Başlangıç ayarlaması gerekiyor.');
        }
    } catch (error) {
        console.error('Oturum kontrolü sırasında hata:', error);
    }
    
    // Bağlantı fonksiyonu
    async function connectToWhatsApp() {
        try {
            // Çok sık yeniden bağlanmayı önle
            const now = Date.now();
            if (now - connectionStatus.lastConnectionTime < 10000) {
                const waitTime = 10000 - (now - connectionStatus.lastConnectionTime);
                console.log(`Çok sık yeniden bağlanma önleniyor. ${waitTime}ms bekleniyor...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            connectionStatus.lastConnectionTime = Date.now();
            connectionStatus.reconnectCount += 1;
            
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
            sock.ev.on('creds.update', async (creds) => {
                await saveCreds();
                if (!connectionStatus.isAuthenticated) {
                    connectionStatus.isAuthenticated = true;
                    console.log('Kimlik doğrulama başarılı, oturum bilgileri kaydedildi.');
                }
            });
            
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
                
                // QR kodu görüntülendiğinde ve daha önce gösterilmediyse
                if (qr && !connectionStatus.qrShown && !sessionFileExists) {
                    connectionStatus.qrShown = true; // QR kodunun gösterildiğini işaretle
                    
                    console.log('\n\n');
                    console.log('=================== QR KOD ===================');
                    console.log('QR KODU WHATSAPP\'TA TARAYIN: (sadece bir kez gösterilecek)');
                    
                    // QR kodu terminal'de görüntüle
                    qrcode.generate(qr, { small: true });
                    
                    console.log('==============================================');
                    console.log('\n\n');
                }
                
                // Bağlantı durumunu kontrol et
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    console.log(`Bağlantı kapandı. Durum kodu: ${statusCode}. Bağlantı deneme sayısı: ${connectionStatus.reconnectCount}`);
                    
                    if (shouldReconnect && connectionStatus.reconnectCount < 10) {
                        console.log('Yeniden bağlanılıyor...');
                        connectToWhatsApp();
                    } else if (connectionStatus.reconnectCount >= 10) {
                        console.log('Maksimum yeniden bağlanma denemesi aşıldı. Bekleniyor...');
                        // 5 dakika bekleyip yeniden dene
                        setTimeout(() => {
                            connectionStatus.reconnectCount = 0;
                            connectToWhatsApp();
                        }, 5 * 60 * 1000);
                    } else {
                        console.log('Oturum sonlandırıldı. Tekrar başlatılıyor...');
                        setTimeout(connectToWhatsApp, 30000);
                    }
                } else if (connection === 'open') {
                    // Bağlantı başarılı oldu, yeniden bağlanma sayacını sıfırla
                    connectionStatus.reconnectCount = 0;
                    connectionStatus.isAuthenticated = true;
                    
                    console.log('\n\n');
                    console.log('====================================');
                    console.log('| WhatsApp Konum Botu aktif!       |');
                    console.log('| "Konum" içeren mesajları dinliyor |');
                    console.log('====================================');
                    console.log('\n');
                    
                    // Oturum dosyasının varlığını güncelle
                    sessionFileExists = true;
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
                        degreesLongitude: LOCATION_DATA.longitude
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
    console.log(`Yeniden başlatma sayısı: ${connectionStatus.reconnectCount}`);
    connectToWhatsApp();
}

// Botu çalıştır
startWhatsAppBot();
