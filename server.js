const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

// السماح بطلبات CORS (مهم للتطبيقات الخارجية)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// بيانات تجريبية (قم بتعديلها لاحقاً لربطها بقاعدة بيانات)
const USERS = {
    'zaki': { password: '1234', status: 'Active', exp_date: '1735689600', is_trial: '0', active_cons: '1' }
};

const CATEGORIES = [
    { category_id: '1', category_name: 'Sports', parent_id: 0 },
    { category_id: '2', category_name: 'News', parent_id: 0 }
];

const LIVE_STREAMS = [
    {
        num: 1,
        name: 'BeIN Sports 1',
        stream_type: 'live',
        stream_id: 101,
        stream_icon: 'https://via.placeholder.com/150',
        epg_channel_id: 'bein1',
        added: '1600000000',
        category_id: '1',
        custom_sid: '',
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
    },
    {
        num: 2,
        name: 'Al Jazeera',
        stream_type: 'live',
        stream_id: 102,
        stream_icon: 'https://via.placeholder.com/150',
        epg_channel_id: 'aljazeera',
        added: '1600000000',
        category_id: '2',
        custom_sid: '',
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
    }
];

// 1. مسار تسجيل الدخول الرئيسي (Player API)
app.get('/player_api.php', (req, res) => {
    const { username, password, action } = req.query;

    // التحقق من المستخدم
    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.json({ user_info: { auth: 0 }, message: 'Invalid credentials' });
    }

    const user = USERS[username];

    // إذا لم يكن هناك إجراء معين، نعيد معلومات الحساب
    if (!action) {
        return res.json({
            user_info: {
                auth: 1,
                status: user.status,
                username: username,
                password: password,
                message: 'Authentication successful',
                exp_date: user.exp_date,
                is_trial: user.is_trial,
                active_cons: user.active_cons,
                allowed_output_formats: ['m3u8', 'ts']
            },
            server_info: {
                url: `https://${req.get('host')}`,
                port: 443,
                https_port: 443,
                protocol: 'https',
                timezone: 'UTC',
                server_protocol: 'https',
                timestamp_now: Math.floor(Date.now() / 1000)
            },
            categories: CATEGORIES
        });
    }

    // handling actions
    if (action === 'get_live_streams') {
        return res.json(LIVE_STREAMS);
    }
    
    if (action === 'get_vod_streams') {
        return res.json([]); // فارغ حالياً
    }

    if (action === 'get_series') {
        return res.json([]); // فارغ حالياً
    }

    if (action === 'get_short_epg') {
        return res.json([]); // يمكن إضافة EPG لاحقاً
    }

    res.json({ error: 'Unknown action' });
});

// 2. مسار get.php (غالباً يستخدم لـ XMLTV أو M3U)
app.get('/get.php', (req, res) => {
    const { username, password, type } = req.query;

    if (!username || !password || !USERS[username] || USERS[username].password !== password) {
        return res.status(403).send('Unauthorized');
    }

    // إذا طلب قائمة M3U
    if (type === 'm3u') {
        let m3uContent = '#EXTM3U\n';
        LIVE_STREAMS.forEach(stream => {
            m3uContent += `#EXTINF:-1 tvg-id="${stream.epg_channel_id}" tvg-logo="${stream.stream_icon}" group-title="${CATEGORIES.find(c => c.category_id === stream.category_id)?.category_name || 'General'}",${stream.name}\n`;
            m3uContent += `https://${req.get('host')}/live/${username}/${password}/${stream.stream_id}.m3u8\n`;
        });
        res.header('Content-Type', 'audio/x-mpegurl');
        return res.send(m3uContent);
    }

    // إذا طلب XMLTV (EPG)
    if (type === 'xmltv') {
        res.header('Content-Type', 'text/xml');
        return res.send('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n</tv>');
    }

    // افتراضي: إعادة JSON للتوافق
    res.json({ status: 'ok', message: 'Endpoint working' });
});

// 3. مسار بث القنوات (Live Stream Simulation)
app.get('/live/:username/:password/:streamId.m3u8', (req, res) => {
    // هنا يجب توجيه الطلب إلى رابط البث الفعلي
    // للتجربة نعيد رابط تجريبي
    res.redirect('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
});

app.listen(port, () => {
    console.log(`Xtream Server running on port ${port}`);
    console.log(`Test URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}:${port}/player_api.php?username=zaki&password=1234`);
});
