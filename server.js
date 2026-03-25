const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Content-Type', 'application/json');
    next();
});

// --- بيانات المستخدم ---
const USERS = {
    'zaki': { 
        password: '1234', 
        status: 'Active', 
        exp_date: '1893456000', 
        is_trial: '0', 
        active_cons: '1' 
    }
};

// --- دالة قراءة وتحليل ملف M3U ---
let cachedChannels = [];
let cachedCategories = [];

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
                // استخراج البيانات من سطر EXTINF
                const nameMatch = line.match(/,(.+)$/);
                const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/);
                const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
                const groupMatch = line.match(/group-title="([^"]*)"/);
                
                currentChannel = {
                    name: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
                    stream_icon: tvgLogoMatch ? tvgLogoMatch[1].trim() : '',
                    epg_channel_id: tvgIdMatch ? tvgIdMatch[1].trim() : '',
                    group_title: groupMatch ? groupMatch[1].trim() : 'Uncategorized',
                    stream_url: ''
                };
                
                if (currentChannel.group_title) {
                    categoriesSet.add(currentChannel.group_title);
                }
                
            } else if (!line.startsWith('#') && currentChannel) {
                // هذا هو رابط البث (السطر الذي يلي EXTINF)
                currentChannel.stream_url = line;
                currentChannel.stream_id = Buffer.from(currentChannel.stream_url).toString('base64').slice(0, 20);
                
                channels.push({ ...currentChannel });
                currentChannel = null;
            }
        }

        // تحويل الفئات إلى مصفوفة
        const categories = Array.from(categoriesSet).map((cat, index) => ({
            category_id: String(index + 1),
            category_name: cat,
            parent_id: 0
        }));

        // إضافة أرقام تسلسلية للقنوات
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
        console.error('❌ Error parsing M3U:', err.message);
        return { channels: [], categories: [] };
    }
}

// --- تحميل القنوات عند بدء التشغيل ---
function loadPlaylist() {
    const playlistPath = path.join(__dirname, 'playlist.m3u');
    if (fs.existsSync(playlistPath)) {
        const parsed = parseM3U(playlistPath);
        cachedChannels = parsed.channels;
        cachedCategories = parsed.categories;
        console.log(`✅ Loaded ${cachedChannels.length} channels, ${cachedCategories.length} categories from playlist.m3u`);
    } else {
        console.warn('⚠️ playlist.m3u not found, using empty list');
        cachedChannels = [];
        cachedCategories = [];
    }
}

// تحميل أولي
loadPlaylist();

// دالة مساعدة للرابط الأساسي
function getBaseUrl(req) {
    return `https://${req.get('host')}`.trim();
}

// --- 1. API الرئيسي: player_api.php ---
app.get('/player_api.php', (req, res) => {
    const { username, password, action } = req.query;

    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.json({ user_info: { auth: 0 }, message: 'Invalid credentials' });
    }

    const baseUrl = getBaseUrl(req);

    // تسجيل الدخول
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

    // جلب الفئات
    if (action === 'get_live_categories') {
        return res.json(cachedCategories);
    }

    // جلب القنوات
    if (action === 'get_live_streams') {
        // إضافة روابط البث عبر الخادم
        const streams = cachedChannels.map(ch => ({
            ...ch,
            stream_url: `${baseUrl}/stream/${ch.stream_id}`
        }));
        return res.json(streams);
    }

    // إجراءات أخرى فارغة
    if (['get_vod_streams', 'get_series', 'get_short_epg'].includes(action)) {
        return res.json([]);
    }

    res.json({ error: 'Unknown action' });
});

// --- 2. مسار get.php ---
app.get('/get.php', (req, res) => {
    const { username, password, type } = req.query;

    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.status(403).send('Unauthorized');
    }

    const baseUrl = getBaseUrl(req);

    if (type === 'm3u') {
        let m3u = '#EXTM3U\n';
        cachedChannels.forEach(ch => {
            m3u += `#EXTINF:-1 tvg-id="${ch.epg_channel_id}" tvg-logo="${ch.stream_icon}" group-title="${ch.group_title}",${ch.name}\n`;
            m3u += `${baseUrl}/stream/${ch.stream_id}\n`;
        });
        res.header('Content-Type', 'audio/x-mpegurl');
        return res.send(m3u);
    }

    if (type === 'xmltv') {
        res.header('Content-Type', 'text/xml');
        return res.send('<?xml version="1.0"?><tv></tv>');
    }

    res.json({ status: 'ok' });
});

// --- 3. معالجة البث الفعلي ---
app.get('/stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    // البحث عن القناة الأصلية
    const channel = cachedChannels.find(ch => ch.stream_id === streamId);
    
    if (channel && channel.stream_url) {
        // إعادة توجيه للرابط الأصلي في ملف M3U
        return res.redirect(channel.stream_url);
    }
    
    res.status(404).json({ error: 'Stream not found' });
});

// --- 4. مسار لإعادة تحميل القائمة ديناميكياً (اختياري) ---
app.get('/reload', (req, res) => {
    loadPlaylist();
    res.json({ status: 'reloaded', channels: cachedChannels.length, categories: cachedCategories.length });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Xtream Server Running on port ${port}`);
    loadPlaylist();
});
