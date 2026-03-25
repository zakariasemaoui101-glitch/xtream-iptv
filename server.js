const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const CONFIG = {
    PORT: process.env.PORT || 8080,
    M3U_URL: process.env.M3U_URL || 'https://iptv-org.github.io/iptv/index.m3u',
    CACHE_TTL_MINUTES: parseInt(process.env.CACHE_TTL_MINUTES) || 360,
    ADMIN_KEY: process.env.ADMIN_KEY || 'change_this_secret_key',
    DEFAULT_USER: process.env.XTREAM_USER || 'zaki',
    DEFAULT_PASS: process.env.XTREAM_PASS || '1234',
    // مدة صلاحية الجلسة بدون نشاط (دقائق)
    SESSION_TIMEOUT_MINUTES: parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 10
};

const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// --- تخزين البيانات ---
let cachedChannels = [];
let cachedCategories = [];
let usersData = {};
let sessionsData = {};
let lastFetchTime = null;
let lastETag = null;

// ============================================
// 🔹 إدارة الجلسات (Sessions)
// ============================================

// تحميل الجلسات من الملف
function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const content = fs.readFileSync(SESSIONS_FILE, 'utf8');
            sessionsData = JSON.parse(content);
            console.log(`🔑 Loaded sessions for ${Object.keys(sessionsData).length} users`);
        } else {
            sessionsData = {};
        }
        return true;
    } catch (err) {
        console.error(`❌ Error loading sessions: ${err.message}`);
        sessionsData = {};
        return false;
    }
}

// حفظ الجلسات في الملف
function saveSessions() {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`❌ Error saving sessions: ${err.message}`);
        return false;
    }
}

// تنظيف الجلسات منتهية الصلاحية
function cleanupExpiredSessions() {
    const now = Math.floor(Date.now() / 1000);
    const timeoutSeconds = CONFIG.SESSION_TIMEOUT_MINUTES * 60;
    let cleaned = 0;

    Object.keys(sessionsData).forEach(username => {
        sessionsData[username] = sessionsData[username].filter(session => {
            const isActive = (now - session.last_activity) < timeoutSeconds;
            if (!isActive) cleaned++;
            return isActive;
        });

        // حذف المستخدم إذا لم يعد لديه جلسات نشطة
        if (sessionsData[username].length === 0) {
            delete sessionsData[username];
        }
    });

    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired sessions`);
        saveSessions();
    }
}

// إنشاء جلسة جديدة
function createSession(username, req) {
    const session = {
        session_id: crypto.randomBytes(16).toString('hex'),
        ip_address: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        login_time: Math.floor(Date.now() / 1000),
        last_activity: Math.floor(Date.now() / 1000)
    };

    if (!sessionsData[username]) {
        sessionsData[username] = [];
    }
    sessionsData[username].push(session);
    saveSessions();
    return session;
}

// تحديث نشاط الجلسة
function updateSessionActivity(username, sessionId) {
    if (sessionsData[username]) {
        const session = sessionsData[username].find(s => s.session_id === sessionId);
        if (session) {
            session.last_activity = Math.floor(Date.now() / 1000);
            saveSessions();
        }
    }
}

// حذف جلسة محددة
function removeSession(username, sessionId) {
    if (sessionsData[username]) {
        sessionsData[username] = sessionsData[username].filter(s => s.session_id !== sessionId);
        if (sessionsData[username].length === 0) {
            delete sessionsData[username];
        }
        saveSessions();
    }
}

// حذف كل جلسات مستخدم
function removeAllUserSessions(username) {
    if (sessionsData[username]) {
        delete sessionsData[username];
        saveSessions();
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
            console.log(`👥 Loaded ${Object.keys(usersData).length} users`);
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
        return true;
    } catch (err) {
        console.error(`❌ Error saving users: ${err.message}`);
        return false;
    }
}

// ============================================
// 🔹 التحقق من المستخدم والجلسة
// ============================================

function authenticateUser(username, password, req) {
    const user = usersData[username];
    if (!user) return { success: false, message: 'Invalid username' };
    if (user.password !== password) return { success: false, message: 'Invalid password' };
    if (user.status !== 'Active') return { success: false, message: 'Account disabled' };

    // التحقق من تاريخ الانتهاء
    const now = Math.floor(Date.now() / 1000);
    if (user.exp_date && parseInt(user.exp_date) < now) {
        return { success: false, message: 'Account expired' };
    }

    // تنظيف الجلسات القديمة قبل التحقق
    cleanupExpiredSessions();

    // التحقق من عدد الاتصالات
    const maxConn = parseInt(user.max_connections) || 1;
    const activeSessions = sessionsData[username] ? sessionsData[username].length : 0;

    if (activeSessions >= maxConn) {
        return { 
            success: false, 
            message: `Maximum connections (${maxConn}) reached. Please disconnect other devices.`,
            active_connections: activeSessions,
            max_connections: maxConn
        };
    }

    // إنشاء جلسة جديدة
    const session = createSession(username, req);
    user.active_cons = String(activeSessions + 1);
    
    return { 
        success: true, 
        message: 'Authentication successful',
        user: { ...user },
        session: session
    };
}

// ============================================
// 🔹 جلب وتحليل M3U
// ============================================

async function fetchAndParseM3U(url) {
    try {
        console.log(`📡 Fetching M3U from: ${url}`);
        const headers = { 'User-Agent': 'Xtream-Server/1.0' };
        if (lastETag) headers['If-None-Match'] = lastETag;

        const response = await fetch(url, { headers, timeout: 15000 });

        if (response.status === 304) {
            console.log('✅ Playlist unchanged (ETag match)');
            lastFetchTime = new Date().toISOString();
            return null;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        lastETag = response.headers.get('etag') || null;
        const content = await response.text();
        return parseM3UContent(content);

    } catch (err) {
        console.error(`❌ Failed to fetch M3U: ${err.message}`);
        return null;
    }
}

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

async function checkAndUpdatePlaylist() {
    const now = Date.now();
    const cacheAge = lastFetchTime ? (now - new Date(lastFetchTime).getTime()) : Infinity;
    const cacheTTLms = CONFIG.CACHE_TTL_MINUTES * 60 * 1000;

    if (cacheAge > cacheTTLms) {
        console.log(`🔄 Cache expired, checking for updates...`);
        const result = await fetchAndParseM3U(CONFIG.M3U_URL);
        if (result) {
            cachedChannels = result.channels;
            cachedCategories = result.categories;
            lastFetchTime = new Date().toISOString();
            console.log(`🎉 Playlist updated! ${cachedChannels.length} channels`);
        } else {
            lastFetchTime = new Date().toISOString();
        }
    }
}

// ============================================
// 🔹 التحميل الأولي
// ============================================

async function initialize() {
    loadUsers();
    loadSessions();
    cleanupExpiredSessions();
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

// ============================================
// 🔹 Xtream Codes API
// ============================================

app.get('/player_api.php', async (req, res) => {
    const { username, password, action } = req.query;
    const baseUrl = getBaseUrl(req);

    await checkAndUpdatePlaylist();

    // التحقق من المستخدم والجلسة
    const authResult = authenticateUser(username, password, req);

    if (!authResult.success) {
        return res.json({ 
            user_info: { auth: 0 }, 
            message: authResult.message,
            active_connections: authResult.active_connections,
            max_connections: authResult.max_connections
        });
    }

    const userInfo = authResult.user;
    const session = authResult.session;

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
                max_connections: userInfo.max_connections,
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
            },
            session_info: {
                session_id: session.session_id,
                ip: session.ip_address,
                login_time: session.login_time
            }
        });
    }

    // تحديث نشاط الجلسة عند كل طلب
    updateSessionActivity(username, session.session_id);

    if (action === 'get_live_categories') {
        return res.json(cachedCategories);
    }

    if (action === 'get_live_streams') {
        const streams = cachedChannels.map(ch => ({
            ...ch,
            stream_url: `${baseUrl}/live/${username}/${password}/${ch.stream_id}/${session.session_id}`
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

    const authResult = authenticateUser(username, password, req);
    if (!authResult.success) {
        return res.status(403).send(`Forbidden: ${authResult.message}`);
    }

    const session = authResult.session;

    if (type === 'm3u') {
        let m3u = '#EXTM3U\n';
        cachedChannels.forEach(ch => {
            const logo = ch.stream_icon ? ` tvg-logo="${ch.stream_icon}"` : '';
            const id = ch.epg_channel_id ? ` tvg-id="${ch.epg_channel_id}"` : '';
            const group = ` group-title="${ch.group_title}"`;
            m3u += `#EXTINF:-1${id}${logo}${group},${ch.name}\n`;
            m3u += `${baseUrl}/live/${username}/${password}/${ch.stream_id}/${session.session_id}\n`;
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
// 🔹 بث القنوات (مع التحقق من الجلسة)
// ============================================

app.get('/live/:user/:pass/:streamId/:sessionId', async (req, res) => {
    const { user, pass, streamId, sessionId } = req.params;

    await checkAndUpdatePlaylist();

    // التحقق من أن الجلسة لا تزال نشطة
    if (!sessionsData[user] || !sessionsData[user].find(s => s.session_id === sessionId)) {
        return res.status(403).json({ error: 'Invalid or expired session' });
    }

    const userInfo = usersData[user];
    if (!userInfo || userInfo.password !== pass || userInfo.status !== 'Active') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    // تحديث النشاط
    updateSessionActivity(user, sessionId);

    const channel = cachedChannels.find(ch => ch.stream_id === streamId);
    if (channel && channel.original_url) {
        return res.redirect(302, channel.original_url);
    }
    res.status(404).json({ error: 'Stream not found' });
});

// ============================================
// 🔹 مسارات إدارة الجلسات (API)
// ============================================

// عرض جلسات المستخدم النشطة
app.get('/api/sessions', (req, res) => {
    const { username, password, admin_key } = req.query;

    // تحقق من المسؤول
    if (admin_key === CONFIG.ADMIN_KEY) {
        // المسؤول يرى كل الجلسات
        return res.json({ sessions: sessionsData, total_users: Object.keys(sessionsData).length });
    }

    // المستخدم العادي يرى جلساته فقط
    const authResult = authenticateUser(username, password, req);
    if (!authResult.success) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const userSessions = sessionsData[username] || [];
    res.json({ 
        username: username, 
        sessions: userSessions, 
        active: userSessions.length,
        max: parseInt(usersData[username].max_connections) || 1
    });
});

// طرد جلسة محددة
app.delete('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { username, admin_key } = req.body;

    if (admin_key !== CONFIG.ADMIN_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    let found = false;
    Object.keys(sessionsData).forEach(user => {
        const before = sessionsData[user].length;
        sessionsData[user] = sessionsData[user].filter(s => s.session_id !== sessionId);
        if (sessionsData[user].length < before) found = true;
        if (sessionsData[user].length === 0) delete sessionsData[user];
    });

    if (found) {
        saveSessions();
        res.json({ status: 'success', message: 'Session terminated' });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// طرد كل جلسات مستخدم معين
app.delete('/api/sessions/user/:username', (req, res) => {
    const { username } = req.params;
    const { admin_key } = req.body;

    if (admin_key !== CONFIG.ADMIN_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (sessionsData[username]) {
        delete sessionsData[username];
        saveSessions();
        res.json({ status: 'success', message: `All sessions for ${username} terminated` });
    } else {
        res.status(404).json({ error: 'No active sessions found' });
    }
});

// ============================================
// 🔹 مسارات إدارية أخرى
// ============================================

app.get('/reload', async (req, res) => {
    lastFetchTime = null;
    await checkAndUpdatePlaylist();
    res.json({ 
        status: 'reloaded', 
        users: Object.keys(usersData).length,
        channels: cachedChannels.length, 
        categories: cachedCategories.length,
        active_sessions: Object.keys(sessionsData).length
    });
});

app.get('/status', (req, res) => {
    const cacheAge = lastFetchTime ? Math.round((Date.now() - new Date(lastFetchTime).getTime()) / 60000) : 'N/A';
    const totalSessions = Object.values(sessionsData).reduce((sum, arr) => sum + arr.length, 0);

    res.json({ 
        status: 'running',
        m3u_source: CONFIG.M3U_URL,
        cache_ttl_minutes: CONFIG.CACHE_TTL_MINUTES,
        cache_age_minutes: cacheAge,
        users_count: Object.keys(usersData).length,
        active_sessions: totalSessions,
        channels_loaded: cachedChannels.length,
        session_timeout_minutes: CONFIG.SESSION_TIMEOUT_MINUTES,
        last_update: lastFetchTime
    });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'running',
        features: [
            'Xtream Codes API',
            'M3U Playlist',
            'Session Management',
            'Connection Limiting',
            'Auto M3U Update'
        ],
        endpoints: [
            '/player_api.php?username=USER&password=PASS',
            '/get.php?username=USER&password=PASS&type=m3u',
            '/status',
            '/reload',
            '/api/sessions?username=USER&password=PASS'
        ] 
    });
});

// تشغيل الخادم
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Xtream Server running on port ${port}`);
    console.log(`📡 M3U Source: ${CONFIG.M3U_URL}`);
    console.log(`🔒 Session Timeout: ${CONFIG.SESSION_TIMEOUT_MINUTES} minutes`);
    console.log(`👥 Users: ${Object.keys(usersData).length}, Sessions: ${Object.keys(sessionsData).length}`);
});
