const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 8080;

// Middleware أساسي
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- بيانات المستخدمين ---
const USERS = {
    'zaki': { 
        password: '1234', 
        status: 'Active', 
        exp_date: '1893456000', 
        is_trial: '0', 
        active_cons: '1',
        max_connections: '1'
    }
};

// --- تخزين القنوات والفئات في الذاكرة ---
let cachedChannels = [];
let cachedCategories = [];

// --- دالة تحليل ملف M3U ---
function parseM3U(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        const channels = [];
        const categoriesSet = new Set();
        let currentChannel = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const nameMatch = line.match(/,(.+)$/);
                const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/i);
                const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
                const groupMatch = line.match(/group-title="([^"]*)"/i);
                
                currentChannel = {
                    name: nameMatch ? nameMatch[1].trim() : 'Unknown',
                    stream_icon: tvgLogoMatch ? tvgLogoMatch[1].trim() : '',
                    epg_channel_id: tvgIdMatch ? tvgIdMatch[1].trim() : '',
                    group_title: groupMatch ? groupMatch[1].trim() : 'Uncategorized',
                    original_url: ''
                };
                if (currentChannel.group_title) categoriesSet.add(currentChannel.group_title);
                
            } else if (!line.startsWith('#') && currentChannel) {
                currentChannel.original_url = line.trim();
                // إنشاء stream_id فريد وآمن
                currentChannel.stream_id = Buffer.from(currentChannel.original_url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || String(Date.now() + Math.random());
                channels.push({ ...currentChannel });
                currentChannel = null;
            }
        }

        const categories = Array.from(categoriesSet).map((cat, idx) => ({
            category_id: String(idx + 1),
            category_name: cat,
            parent_id: 0
        }));

        channels.forEach((ch, idx) => {
            ch.num = idx + 1;
            ch.stream_type = 'live';
            ch.added = String(Math.floor(Date.now() / 1000));
            ch.category_id = categories.find(c => c.category_name === ch.group_title)?.category_id || '1';
            ch.custom_sid = '';
            ch.tv_archive = 0;
            ch.direct_source = '';
            ch.tv_archive_duration = 0;
        });

        return { channels, categories };
    } catch (err) {
        console.error('❌ M3U Parse Error:', err.message);
        return { channels: [], categories: [] };
    }
}

// --- تحميل playlist.m3u ---
function loadPlaylist() {
    const playlistPath = path.join(__dirname, 'playlist.m3u');
    if (fs.existsSync(playlistPath)) {
        const parsed = parseM3U(playlistPath);
        cachedChannels = parsed.channels;
        cachedCategories = parsed.categories;
        console.log(`✅ Loaded: ${cachedChannels.length} channels | ${cachedCategories.length} categories`);
    } else {
        console.warn('⚠️ playlist.m3u not found');
        cachedChannels = [];
        cachedCategories = [];
    }
}
loadPlaylist();

// --- دالة الرابط الأساسي (بدون مسافات) ---
function getBaseUrl(req) {
    return `https://${req.get('host')}`.trim().replace(/\s+/g, '');
}

// ============================================
// 🔹 Xtream Codes API Endpoints
// ============================================

// 1. player_api.php - تسجيل الدخول + الإجراءات
app.get('/player_api.php', (req, res) => {
    const { username, password, action } = req.query;
    const baseUrl = getBaseUrl(req);

    // التحقق من المستخدم
    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.json({ user_info: { auth: 0 }, message: 'Invalid credentials' });
    }

    // أ) استجابة تسجيل الدخول الأساسية
    if (!action) {
        return res.json({
            user_info: {
                auth: 1,
                status: USERS[username].status,
                username: username,
                password: password,
                message: 'Authentication successful',
                exp_date: USERS[username].exp_date,
                is_trial: USERS[username].is_trial,
                active_cons: USERS[username].active_cons,
                allowed_output_formats: ['m3u8', 'ts']
            },
            server_info: {
                url: baseUrl,
                port: 443,
                https_port: 443,
                protocol: 'https',
                timezone: 'UTC',
                server_protocol: 'https',
                timestamp_now: Math.floor(Date.now() / 1000)
            }
        });
    }

    // ب) جلب الفئات
    if (action === 'get_live_categories') {
        return res.json(cachedCategories);
    }

    // ج) جلب القنوات الحية
    if (action === 'get_live_streams') {
        const streams = cachedChannels.map(ch => ({
            ...ch,
            stream_url: `${baseUrl}/live/${username}/${password}/${ch.stream_id}`
        }));
        return res.json(streams);
    }

    // د) إجراءات فارغة (لتجنب الأخطاء في التطبيقات)
    if (['get_vod_streams', 'get_series', 'get_short_epg', 'get_vod_categories', 'get_series_categories'].includes(action)) {
        return res.json([]);
    }

    res.json({ error: 'Unknown action' });
});

// ============================================
// 🔹 M3U Playlist Endpoint (get.php)
// ============================================
app.get('/get.php', (req, res) => {
    const { username, password, type } = req.query;
    const baseUrl = getBaseUrl(req);

    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.status(403).send('Unauthorized');
    }

    // طلب M3U Playlist
    if (type === 'm3u') {
        let m3u = '#EXTM3U\n';
        cachedChannels.forEach(ch => {
            const logo = ch.stream_icon ? ` tvg-logo="${ch.stream_icon}"` : '';
            const id = ch.epg_channel_id ? ` tvg-id="${ch.epg_channel_id}"` : '';
            const group = ` group-title="${ch.group_title}"`;
            m3u += `#EXTINF:-1${id}${logo}${group},${ch.name}\n`;
            m3u += `${baseUrl}/live/${username}/${password}/${ch.stream_id}\n`;
        });
        res.header('Content-Type', 'audio/x-mpegurl; charset=utf-8');
        return res.send(m3u);
    }

    // طلب XMLTV (EPG)
    if (type === 'xmltv') {
        res.header('Content-Type', 'text/xml; charset=utf-8');
        return res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
    }

    res.json({ status: 'ok', message: 'Use ?type=m3u or ?type=xmltv' });
});

// ============================================
// 🔹 بث القنوات (Stream Proxy/Redirect)
// ============================================
app.get('/live/:user/:pass/:streamId', (req, res) => {
    const { user, pass, streamId } = req.params;
    
    // تحقق سريع من الصلاحيات
    if (!USERS[user] || USERS[user].password !== pass) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const channel = cachedChannels.find(ch => ch.stream_id === streamId);
    if (channel && channel.original_url) {
        // إعادة توجيه للرابط الأصلي
        return res.redirect(302, channel.original_url);
    }
    res.status(404).json({ error: 'Stream not found' });
});

// ============================================
// 🔹 مسارات إضافية مفيدة
// ============================================

// إعادة تحميل القائمة دون إعادة تشغيل الخادم
app.get('/reload', (req, res) => {
    loadPlaylist();
    res.json({ status: 'reloaded', channels: cachedChannels.length, categories: cachedCategories.length });
});

// اختبار بسيط
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        endpoints: [
            '/player_api.php?username=zaki&password=1234',
            '/get.php?username=zaki&password=1234&type=m3u',
            '/reload'
        ] 
    });
});

// تشغيل الخادم
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Xtream Server running on port ${port}`);
});
