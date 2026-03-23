// xtream.js - XTream IPTV Server with M3U Parser
// ⚠️ هذا الملف يجب أن يكون هو الرئيسي في مستودعك

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ إعدادات أساسية
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 إعدادات المستخدم
const CONFIG = {
  username: process.env.XTREAM_USER || 'zaki',
  password: process.env.XTREAM_PASS || '1234',
  server_name: 'My Xtream Server',
  m3u_url: 'https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/main/playlist.m3u'
};

// 🗄️ ذاكرة التخزين المؤقت
let cachedData = { channels: [], categories: [], lastUpdate: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 دقيقة

// 🔍 محلل M3U مبسط
function parseM3U(content) {
  const lines = content.split('\n').filter(l => l.trim());
  const channels = [];
  const categories = new Map();
  let current = null;
  
  for (const line of lines) {
    if (line.startsWith('#EXTM3U')) continue;
    
    if (line.startsWith('#EXTINF:')) {
      // استخراج الاسم (بعد آخر فاصلة)
      const nameMatch = line.match(/,(.+)$/);
      const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
      
      // استخراج group-title
      const groupMatch = line.match(/group-title="([^"]*)"/);
      const group = groupMatch ? groupMatch[1].trim() : 'Uncategorized';
      
      // استخراج tvg-logo
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const logo = logoMatch ? logoMatch[1] : '';
      
      // استخراج tvg-id
      const idMatch = line.match(/tvg-id="([^"]*)"/);
      const tvgId = idMatch ? idMatch[1] : '';
      
      current = { name, group, logo, tvgId, url: '' };
      
      // إضافة الفئة إذا جديدة
      if (group && !categories.has(group)) {
        categories.set(group, {
          category_id: categories.size + 1,
          category_name: group,
          parent_id: 0
        });
      }
      continue;
    }
    
    if (current && !line.startsWith('#') && line.startsWith('http')) {
      current.url = line.trim();
      current.stream_id = Buffer.from(current.name).toString('base64').slice(0, 12);
      channels.push({ ...current });
      current = null;
    }
  }
  
  return { channels, categories: Array.from(categories.values()) };
}

// 📥 جلب وتحليل M3U
async function fetchChannels() {
  try {
    const now = Date.now();
    if (cachedData.channels.length > 0 && now - cachedData.lastUpdate < CACHE_TTL) {
      return cachedData;
    }
    
    console.log('🔄 Fetching M3U from:', CONFIG.m3u_url);
    const { data } = await axios.get(CONFIG.m3u_url, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    const { channels, categories } = parseM3U(data);
    console.log(`✅ Loaded ${channels.length} channels, ${categories.length} categories`);
    
    cachedData = { channels, categories, lastUpdate: now };
    return cachedData;
    
  } catch (err) {
    console.error('❌ M3U fetch error:', err.message);
    return cachedData; // إرجاع البيانات القديمة إذا فشل الجلب
  }
}

// 🔐 دالة المصادقة
function auth(req) {
  const { username, password } = req.query;
  return username === CONFIG.username && password === CONFIG.password;
}

// 🌐 الحصول على رابط الخادم
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// ================== 🎯 نقاط النهاية الرئيسية ==================

// ✅ player_api.php - متوافق مع Xtream Apps
app.get(['/player_api.php', '/api', '/'], async (req, res) => {
  const { action } = req.query;
  
  if (!auth(req)) {
    return res.json({ user_info: { auth: 0, message: 'Invalid credentials' } });
  }
  
  await fetchChannels();
  const baseUrl = getBaseUrl(req);
  const { channels, categories } = cachedData;
  
  const baseInfo = {
    user_info: {
      auth: 1, username: CONFIG.username, password: CONFIG.password,
      message: 'OK', status: 'Active', exp_date: '2099-12-31',
      is_trial: '0', active_cons: '0', max_connections: '1',
      allowed_output_formats: ['m3u8', 'ts']
    },
    server_info: {
      url: baseUrl, server_name: CONFIG.server_name,
      server_protocol: baseUrl.split('://')[0],
      https_port: '443', http_port: '80', timezone: 'UTC',
      timestamp_now: Math.floor(Date.now() / 1000), process: '1'
    }
  };
  
  switch (action) {
    case 'get_live_categories':
      return res.json(categories);
      
    case 'get_live_streams': {
      const catId = req.query.category_id;
      let filtered = channels;
      if (catId) {
        const cat = categories.find(c => c.category_id.toString() === catId);
        if (cat) filtered = channels.filter(ch => ch.group === cat.category_name);
      }
      return res.json(filtered.map(ch => ({
        num: ch.stream_id, name: ch.name, stream_type: 'live',
        stream_id: ch.stream_id, stream_icon: ch.logo,
        epg_channel_id: ch.tvgId || null, added: '0',
        category_id: categories.find(c => c.category_name === ch.group)?.category_id.toString() || '0',
        custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0,
        stream_url: `${baseUrl}/live/${CONFIG.username}/${CONFIG.password}/${ch.stream_id}.m3u8`
      })));
    }
    
    case 'get_vod_categories':
    case 'get_series_categories':
    case 'get_vod_streams':
    case 'get_series':
      return res.json([]);
      
    case 'get_short_epg':
      return res.json({ epg_listings: [] });
      
    default:
      return res.json({
        ...baseInfo,
        categories: categories.slice(0, 20),
        live_streams: channels.slice(0, 20).map(ch => ({
          num: ch.stream_id, name: ch.name, stream_type: 'live',
          stream_id: ch.stream_id, stream_icon: ch.logo,
          category_id: categories.find(c => c.category_name === ch.group)?.category_id.toString() || '0',
          stream_url: `${baseUrl}/live/${CONFIG.username}/${CONFIG.password}/${ch.stream_id}.m3u8`
        }))
      });
  }
});

// 🔴 نقطة البث المباشر
app.get('/live/:user/:pass/:streamId.:ext?', async (req, res) => {
  const { user, pass, streamId } = req.params;
  
  if (user !== CONFIG.username || pass !== CONFIG.password) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await fetchChannels();
  const channel = cachedData.channels.find(c => c.stream_id === streamId);
  
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  
  // إعادة توجيه مباشرة (لتوفير النطاق على Render)
  res.redirect(302, channel.url);
});

// 📄 ملف M3U للتطبيقات البسيطة
app.get('/get.php', async (req, res) => {
  if (!auth(req)) {
    return res.status(403).send('# Authentication failed');
  }
  
  await fetchChannels();
  const baseUrl = getBaseUrl(req);
  const { channels } = cachedData;
  
  let output = `#EXTM3U\n`;
  channels.forEach(ch => {
    output += `#EXTINF:-1 tvg-id="${ch.tvgId}" tvg-name="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group}",${ch.name}\n`;
    output += `${baseUrl}/live/${CONFIG.username}/${CONFIG.password}/${ch.stream_id}.m3u8\n`;
  });
  
  res.set('Content-Type', 'application/x-mpegURL');
  res.send(output);
});

// 📰 EPG بسيط
app.get('/epg.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><tv><channel id="1"><display-name>Sample</display-name></channel></tv>`);
});

// 🏠 صفحة الحالة
app.get('/status', async (req, res) => {
  await fetchChannels();
  res.json({
    status: 'online',
    channels: cachedData.channels.length,
    categories: cachedData.categories.length,
    lastUpdate: new Date(cachedData.lastUpdate).toISOString(),
    uptime: process.uptime()
  });
});

// ❌ معالجة المسارات غير الموجودة
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', endpoints: ['/player_api.php', '/get.php', '/live/:user/:pass/:id.m3u8', '/status'] });
});

// 🚀 تشغيل الخادم
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Xtream Server running on port ${PORT}`);
  console.log(`📡 API: /player_api.php`);
  console.log(`🔗 M3U: /get.php?username=${CONFIG.username}&password=${CONFIG.password}`);
});
