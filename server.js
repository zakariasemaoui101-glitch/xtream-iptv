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

// --- إعدادات التحديث التلقائي ---
const CONFIG = {
    PORT: process.env.PORT || 8080,
    // رابط iptv-org الرسمي (يمكن تغييره لدولة محددة)
    M3U_URL: process.env.M3U_URL || 'https://iptv-org.github.io/iptv/index.m3u',
    // مدة صلاحية الكاش (6 ساعات = 360 دقيقة)
    CACHE_TTL_MINUTES: parseInt(process.env.CACHE_TTL_MINUTES) || 360,
    ADMIN_KEY: process.env.ADMIN_KEY || 'change_this_secret_key',
    DEFAULT_USER: process.env.XTREAM_USER || 'zaki',
    DEFAULT_PASS: process.env.XTREAM_PASS || '1234'
};

const USERS_FILE = path.join(__dirname, 'users.json');

// --- تخزين البيانات ---
let cachedChannels = [];
let cachedCategories = [];
let usersData = {};
let lastFetchTime = null;
let lastETag = null; // لتتبع التغييرات

// ============================================
// 🔹 دالة جلب M3U مع التحقق من التغييرات (ETag)
// ============================================
async function fetchAndParseM3U(url) {
    try {
        console.log(`📡 Fetching M3U from: ${url}`);
        
        const headers = { 'User-Agent': 'Xtream-Server/1.0' };
        // إذا كان لدينا ETag سابق، نرسله للتحقق من التغيير
        if (lastETag) {
            headers['If-None-Match'] = lastETag;
        }
        
        const response = await fetch(url, { headers, timeout: 15000 });
        
        // إذا لم يتغير الملف (304 Not Modified)
        if (response.status === 304) {
            console.log('✅ Playlist unchanged (ETag match), using cached version');
            lastFetchTime = new Date().toISOString();
            return null; // لا حاجة للتحديث
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // حفظ ETag الجديد للمستقبل
        lastETag = response.headers.get('etag') || null;
        console.log(`🏷️ New ETag: ${lastETag}`);
        
        const content = await response.text();
        return parseM3UContent(content);
        
    } catch (err) {
        console.error(`❌ Failed to fetch M3U: ${err.message}`);
        return null;
    }
}

// ============================================
// 🔹 دالة تحليل محتوى M3U
// ============================================
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

    console.log(`✅ Parsed: ${channels.length} channels, ${categories.length} categories`);
    return { channels, categories };
}

// ============================================
// 🔹 دالة التحقق من التحديث (ذكية)
// ============================================
async function checkAndUpdatePlaylist() {
    const now = Date.now();
    const cacheAge = lastFetchTime ? (now - new Date(lastFetchTime).getTime()) : Infinity;
    const cacheTTLms = CONFIG.CACHE_TTL_MINUTES * 60 * 1000;
    
    // إذا مر وقت كافٍ منذ آخر تحديث، نتحقق من التحديث
    if (cacheAge > cacheTTLms) {
        console.log(`🔄 Cache expired (${Math.round(cacheAge/60000)} min > ${CONFIG.CACHE_TTL_MINUTES} min), checking for updates...`);
        const result = await fetchAndParseM3U(CONFIG.M3U_URL);
        
        if (result) {
            cachedChannels = result.channels;
            cachedCategories = result.categories;
            lastFetchTime = new Date().toISOString();
            console.log(`🎉 Playlist updated! ${cachedChannels.length} channels loaded`);
        } else {
            // لم يتغير الملف، نحدث وقت الكاش فقط
            lastFetchTime = new Date().toISOString();
            console.log(`⏰ Cache timestamp refreshed, content unchanged`);
        }
    } else {
        console.log(`✅ Cache valid (${Math.round(cacheAge/60000)} min < ${CONFIG.CACHE_TTL_MINUTES} min)`);
    }
}

// ============================================
// 🔹 إدارة المستخدمين
// ============================================
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const content = fs.readFileSync(USERS_FILE, 'utf8');
            usersData = JSON.parse(content);
            console.log(`👥 Loaded ${Object.keys(usersData).length} users from users.json`);
        } else {
            console.warn('⚠️ users.json not found! Creating default user');
            usersData = {
                [CONFIG.DEFAULT_USER]: {
                    password: CONFIG.DEFAULT_PASS,
                    status: 'Active',
                    exp_date: '1893456000',
                    is_trial: '0',
                    active_cons: '0',
                    max_connections: '1'
                }
            };
        }
        return true;
    } catch (err) {
        console.error(`❌ Error loading users: ${err.message}`);
        usersData = {
            [CONFIG.DEFAULT_USER]: {
                password: CONFIG.DEFAULT_PASS,
                status: 'Active',
                exp_date: '1893456000',
                is_trial: '0',
                active_cons: '0',
                max_connections: '1'
            }
        };
        return false;
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
        console.log('💾 Users saved to users.json');
        return true;
    } catch (err) {
        console.error(`❌ Error saving users: ${err.message}`);
        return false;
    }
}

// ============================================
// 🔹 التحميل الأولي
// ============================================
async function initialize() {
    loadUsers();
    console.log('🔄 Initial playlist load...');
    await checkAndUpdatePlaylist();
}
initialize();

// ============================================
// 🔹 دوال مساعدة
// ============================================
function getBaseUrl(req) {
    return `https://${req.get('host')}`.trim().replace(/\s+/g, '');
}

function authenticateUser(username, password) {
    const user = usersData[username];
    if (!user) return null;
    if (user.password !== password) return null;
    if (user.status !== 'Active') return null;
    
    const now = Math.floor(Date.now() / 1000);
    if (user.exp_date && parseInt(user.exp_date) < now) {
        return { ...user, auth: 0, message: 'Account expired' };
    }
    
    return { ...user, auth: 1, message: 'Authentication successful' };
}

// ============================================
// 🔹 Xtream Codes API
// ============================================
app.get('/player_api.php', async (req, res) => {
    const { username, password, action } = req.query;
    const baseUrl = getBaseUrl(req);

    // ✅ التحقق من التحديث قبل كل طلب مهم
    await checkAndUpdatePlaylist();

    const userInfo = authenticateUser(username, password);
    if (!userInfo || userInfo.auth !== 1) {
        return res.json({ user_info: { auth: 0 }, message: userInfo?.message || 'Invalid credentials' });
    }

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

    if (action === 'get_live_categories') {
        return res.json(cachedCategories);
    }

    if (action === 'get_live_streams') {
        const streams = cachedChannels.map(ch => ({
            ...ch,
            stream_url: `${baseUrl}/live/${username}/${password}/${ch.stream_id}`
        }));
        return res.json(streams);
    }

    if (['get_vod_streams', 'get_series', 'get_short_epg', 'get_vod_categories', 'get_series_categories'].includes(action)) {
        return res.json([]);
    }

    res.json({ error: 'Unknown action' });
});

// ============================================
// 🔹 M3U Endpoint
// ============================================
app.get('/get.php', async (req, res) => {
    const { username, password, type } = req.query;
    const baseUrl = getBaseUrl(req);

    await checkAndUpdatePlaylist();

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
app.get('/live/:user/:pass/:streamId', async (req, res) => {
    const { user, pass, streamId } = req.params;
    
    await checkAndUpdatePlaylist();

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
// 🔹 مسارات إدارية
// ============================================
app.get('/reload', async (req, res) => {
    // تحديث فوري بغض النظر عن الكاش
    console.log('🔄 Manual reload requested...');
    lastFetchTime = null; // إعادة تعيين الكاش
    await checkAndUpdatePlaylist();
    res.json({ 
        status: 'reloaded', 
        users: Object.keys(usersData).length,
        channels: cachedChannels.length, 
        categories: cachedCategories.length,
        lastFetch: lastFetchTime,
        etag: lastETag
    });
});

app.get('/status', (req, res) => {
    const cacheAge = lastFetchTime ? 
        Math.round((Date.now() - new Date(lastFetchTime).getTime()) / 60000) : 'N/A';
    
    res.json({ 
        status: 'running',
        m3u_source: CONFIG.M3U_URL,
        cache_ttl_minutes: CONFIG.CACHE_TTL_MINUTES,
        cache_age_minutes: cacheAge,
        etag: lastETag,
        users_count: Object.keys(usersData).length,
        channels_loaded: cachedChannels.length,
        categories_loaded: cachedCategories.length,
        last_update: lastFetchTime
    });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'running',
        endpoints: [
            '/player_api.php?username=USER&password=PASS',
            '/get.php?username=USER&password=PASS&type=m3u',
            '/status',
            '/reload'
        ] 
    });
});

// ============================================
// 🔹 تشغيل الخادم
// ============================================
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Xtream Server running on port ${port}`);
    console.log(`📡 M3U Source: ${CONFIG.M3U_URL}`);
    console.log(`⏰ Auto-update TTL: ${CONFIG.CACHE_TTL_MINUTES} minutes`);
});
