const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- إعدادات ---
const M3U_URL = process.env.M3U_URL || 'https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/main/playlist.m3u';
const USERS_FILE = path.join(__dirname, 'users.json');

// تخزين البيانات
let cachedChannels = [];
let cachedCategories = [];
let usersData = {};
let lastFetchTime = null;

// --- دالة قراءة المستخدمين من users.json ---
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const content = fs.readFileSync(USERS_FILE, 'utf8');
            usersData = JSON.parse(content);
            console.log(`👥 Loaded ${Object.keys(usersData).length} users from users.json`);
            return true;
        } else {
            console.warn('⚠️ users.json not found, using empty users');
            usersData = {};
            return false;
        }
    } catch (err) {
        console.error(`❌ Error loading users.json: ${err.message}`);
        usersData = {};
        return false;
    }
}

// --- دالة حفظ المستخدمين (للتحديث الديناميكي) ---
function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
        console.log('💾 Users saved to users.json');
        return true;
    } catch (err) {
        console.error(`❌ Error saving users.json: ${err.message}`);
        return false;
    }
}

// --- دالة جلب وتحليل M3U من رابط ---
async function fetchAndParseM3U(url) {
    try {
        console.log(`📡 Fetching M3U from: ${url}`);
        const response = await fetch(url, { 
            headers: { 'User-Agent': 'Xtream-Server/1.0' },
            timeout: 10000 
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const content = await response.text();
        return parseM3UContent(content);
    } catch (err) {
        console.error(`❌ Failed to fetch M3U: ${err.message}`);
        return null;
    }
}

// --- دالة تحليل محتوى M3U ---
function parseM3UContent(content) {
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
                stream_icon: tvgLogoMatch ? tvgLogoMatch[1].trim().replace(/\s+/g, '') : '',
                epg_channel_id: tvgIdMatch ? tvgIdMatch[1].trim() : '',
                group_title: groupMatch ? groupMatch[1].trim() : 'Uncategorized',
                original_url: ''
            };
            if (currentChannel.group_title) categoriesSet.add(currentChannel.group_title);
            
        } else if (!line.startsWith('#') && currentChannel && line.startsWith('http')) {
            currentChannel.original_url = line.trim();
            currentChannel.stream_id = Buffer.from(currentChannel.original_url).toString('base64')
                .replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || String(Date.now() + Math.random());
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
}

// --- تحميل البيانات عند البدء ---
async function loadData() {
    loadUsers();
    const result = await fetchAndParseM3U(M3U_URL);
    if (result) {
        cachedChannels = result.channels;
        cachedCategories = result.categories;
        lastFetchTime = new Date().toISOString();
        console.log(`✅ Loaded ${cachedChannels.length} channels`);
    }
}
loadData();

// دالة الرابط الأساسي
function getBaseUrl(req) {
    return `https://${req.get('host')}`.trim().replace(/\s+/g, '');
}

// دالة التحقق من المستخدم
function authenticateUser(username, password) {
    const user = usersData[username];
    if (!user) return null;
    if (user.password !== password) return null;
    if (user.status !== 'Active') return null;
    
    // التحقق من تاريخ الانتهاء
    const now = Math.floor(Date.now() / 1000);
    if (user.exp_date && parseInt(user.exp_date) < now) {
        return { ...user, auth: 0, message: 'Account expired' };
    }
    
    return { ...user, auth: 1, message: 'Authentication successful' };
}

// ============================================
// 🔹 Xtream Codes API
// ============================================

app.get('/player_api.php', (req, res) => {
    const { username, password, action } = req.query;
    const baseUrl = getBaseUrl(req);

    const userInfo = authenticateUser(username, password);
    if (!userInfo || userInfo.auth !== 1) {
        return res.json({ user_info: { auth: 0 }, message: userInfo?.message || 'Invalid credentials' });
    }

    // تسجيل الدخول الأساسي
    if (!action) {
        return res.json({
            user_info: {
                auth: 1,
                status: userInfo.status,
                username: username,
                password: password,
                message: userInfo.message,
                exp_date: userInfo.exp_date,
                is_trial: userInfo.is_trial,
                active_cons: userInfo.active_cons,
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
        const streams = cachedChannels.map(ch => ({
            ...ch,
            stream_url: `${baseUrl}/live/${username}/${password}/${ch.stream_id}`
        }));
        return res.json(streams);
    }

    // إجراءات أخرى
    if (['get_vod_streams', 'get_series', 'get_short_epg', 'get_vod_categories', 'get_series_categories'].includes(action)) {
        return res.json([]);
    }

    res.json({ error: 'Unknown action' });
});

// ============================================
// 🔹 M3U Endpoint (get.php)
// ============================================

app.get('/get.php', (req, res) => {
    const { username, password, type } = req.query;
    const baseUrl = getBaseUrl(req);

    const userInfo = authenticateUser(username, password);
    if (!userInfo || userInfo.auth !== 1) {
        return res.status(403).send('Unauthorized');
    }

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

    if (type === 'xmltv') {
        res.header('Content-Type', 'text/xml; charset=utf-8');
        return res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
    }

    res.json({ status: 'ok' });
});

// ============================================
// 🔹 بث القنوات
// ============================================

app.get('/live/:user/:pass/:streamId', (req, res) => {
    const { user, pass, streamId } = req.params;
    
    const userInfo = authenticateUser(user, pass);
    if (!userInfo || userInfo.auth !== 1) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const channel = cachedChannels.find(ch => ch.stream_id === streamId);
    if (channel && channel.original_url) {
        return res.redirect(302, channel.original_url);
    }
    res.status(404).json({ error: 'Stream not found' });
});

// ============================================
// 🔹 إدارة المستخدمين (API)
// ============================================

// 📝 إضافة مستخدم جديد
app.post('/api/users', (req, res) => {
    const { username, password, admin_key } = req.body;
    
    // 🔐 تحقق بسيط من مفتاح المسؤول (غيّره لشيء سري!)
    if (admin_key !== (process.env.ADMIN_KEY || 'change_this_secret_key')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (usersData[username]) {
        return res.status(409).json({ error: 'User already exists' });
    }
    
    // إنشاء مستخدم جديد بالقيم الافتراضية
    usersData[username] = {
        password: password,
        status: 'Active',
        exp_date: '1893456000',
        is_trial: '0',
        active_cons: '0',
        max_connections: '1'
    };
    
    if (saveUsers()) {
        res.json({ status: 'success', message: `User ${username} created` });
    } else {
        res.status(500).json({ error: 'Failed to save user' });
    }
});

// 🗑️ حذف مستخدم
app.delete('/api/users/:username', (req, res) => {
    const { username } = req.params;
    const { admin_key } = req.body;
    
    if (admin_key !== (process.env.ADMIN_KEY || 'change_this_secret_key')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!usersData[username]) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    delete usersData[username];
    
    if (saveUsers()) {
        res.json({ status: 'success', message: `User ${username} deleted` });
    } else {
        res.status(500).json({ error: 'Failed to save changes' });
    }
});

// 📋 عرض جميع المستخدمين (للمسؤول فقط)
app.get('/api/users', (req, res) => {
    const { admin_key } = req.query;
    
    if (admin_key !== (process.env.ADMIN_KEY || 'change_this_secret_key')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // إخفاء كلمات المرور في الاستجابة
    const safeUsers = {};
    Object.keys(usersData).forEach(key => {
        const { password, ...rest } = usersData[key];
        safeUsers[key] = rest;
    });
    
    res.json({ users: safeUsers, count: Object.keys(safeUsers).length });
});

// ============================================
// 🔹 مسارات إدارية أخرى
// ============================================

// إعادة تحميل القائمة والمستخدمين
app.get('/reload', async (req, res) => {
    loadUsers();
    await loadData();
    res.json({ 
        status: 'reloaded', 
        users: Object.keys(usersData).length,
        channels: cachedChannels.length, 
        categories: cachedCategories.length,
        lastFetch: lastFetchTime 
    });
});

// حالة الخادم
app.get('/', (req, res) => {
    res.json({ 
        status: 'running',
        m3u_source: M3U_URL,
        users_count: Object.keys(usersData).length,
        channels_loaded: cachedChannels.length,
        last_update: lastFetchTime,
        endpoints: [
            '/player_api.php?username=USER&password=PASS',
            '/get.php?username=USER&password=PASS&type=m3u',
            '/reload',
            'POST /api/users (add user)',
            'DELETE /api/users/:username (delete user)'
        ] 
    });
});

// تشغيل الخادم
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Xtream Server running on port ${port}`);
    console.log(`📡 M3U Source: ${M3U_URL}`);
    console.log(`👥 Users loaded: ${Object.keys(usersData).length}`);
});
