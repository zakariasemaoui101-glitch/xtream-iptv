// server.js - XTream IPTV Server with M3U Parser
// متوافق مع Render.com + Xtream Apps + ملفات M3U

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// ================== إعدادات أساسية ==================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== إعدادات التكوين ==================
const CONFIG = {
  username: process.env.XTREAM_USER || 'zaki',
  password: process.env.XTREAM_PASS || '1234',
  server_name: process.env.SERVER_NAME || 'My Xtream Server',
  server_url: process.env.SERVER_URL || '',
  max_connections: process.env.MAX_CONN || '1',
  expiration_date: process.env.EXP_DATE || '2099-12-31',
  m3u_url: process.env.M3U_URL || 'https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/main/playlist.m3u',
  cache_duration: parseInt(process.env.CACHE_MIN) || 30 // دقيقة
};

// ================== ذاكرة التخزين المؤقت ==================
let cachedChannels = [];
let cachedCategories = [];
let lastCacheUpdate = 0;

// ================== محلل ملفات M3U المتقدم ==================
class M3UParser {
  
  // تحليل سطر #EXTINF واستخراج البيانات
  static parseExtInf(line) {
    const result = {
      duration: null,
      attributes: {},
      name: ''
    };
    
    // استخراج المدة
    const durationMatch = line.match(/^#EXTINF:(-?\d+)/);
    if (durationMatch) result.duration = parseInt(durationMatch[1]);
    
    // استخراج السمات (key="value" أو key=value)
    const attrRegex = /(\w+(?:-\w+)*)="([^"]*)"|(\w+(?:-\w+)*)=([^\s,]+)/g;
    let match;
    while ((match = attrRegex.exec(line)) !== null) {
      const key = match[1] || match[3];
      const value = match[2] || match[4];
      if (key && value) result.attributes[key] = value;
    }
    
    // استخراج اسم القناة (بعد آخر فاصلة)
    const nameMatch = line.match(/,(.+)$/);
    if (nameMatch) result.name = nameMatch[1].trim();
    
    return result;
  }
  
  // تحليل ملف M3U كامل
  static async parseM3U(content) {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    const channels = [];
    let currentChannel = null;
    let currentExtVlcOpts = {};
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // تخطي الرأس
      if (line === '#EXTM3U') continue;
      
      // معالجة خيارات VLC الإضافية
      if (line.startsWith('#EXTVLCOPT:')) {
        const opt = line.replace('#EXTVLCOPT:', '');
        if (opt.startsWith('http-user-agent=')) {
          currentExtVlcOpts['user-agent'] = opt.split('=')[1];
        } else if (opt.startsWith('http-referrer=')) {
          currentExtVlcOpts['referrer'] = opt.split('=')[1];
        }
        continue;
      }
      
      // معالجة سطر القناة
      if (line.startsWith('#EXTINF:')) {
        const parsed = this.parseExtInf(line);
        currentChannel = {
          stream_id: channels.length + 1,
          name: parsed.name,
          tvg_id: parsed.attributes['tvg-id'] || '',
          tvg_logo: parsed.attributes['tvg-logo'] || '',
          group_title: parsed.attributes['group-title'] || 'Uncategorized',
          user_agent: parsed.attributes['user-agent'] || currentExtVlcOpts['user-agent'] || '',
          referrer: parsed.attributes['referrer'] || currentExtVlcOpts['referrer'] || '',
          stream_url: '',
          added: Math.floor(Date.now() / 1000).toString(),
          tv_archive: 0,
          custom_sid: ''
        };
        currentExtVlcOpts = {}; // إعادة تعيين
        continue;
      }
      
      // معالجة رابط البث
      if (currentChannel && !line.startsWith('#')) {
        currentChannel.stream_url = line;
        currentChannel.stream_id = this.generateStreamId(currentChannel.tvg_id, currentChannel.name);
        channels.push({ ...currentChannel });
        currentChannel = null;
      }
    }
    
    return channels;
  }
  
  // توليد معرف فريد للقناة
  static generateStreamId(tvgId, name) {
    const clean = (tvgId || name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const hash = clean.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return Math.abs(hash).toString(36) + clean.substring(0, 8);
  }
  
  // استخراج الفئات الفريدة من القنوات
  static extractCategories(channels) {
    const categories = {};
    channels.forEach(ch => {
      const groups = ch.group_title.split(';').map(g => g.trim());
      groups.forEach(group => {
        if (group && !categories[group]) {
          categories[group] = {
            category_id: Object.keys(categories).length + 1,
            category_name: group,
            parent_id: 0
          };
        }
      });
    });
    return Object.values(categories);
  }
}

// ================== دوال جلب وتحليل M3U ==================
async function fetchAndParseM3U() {
  try {
    let content;
    
    // محاولة جلب من الرابط أو قراءة ملف محلي
    if (CONFIG.m3u_url.startsWith('http')) {
      const response = await axios.get(CONFIG.m3u_url, {
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      content = response.data;
    } else {
      content = await fs.readFile(CONFIG.m3u_url, 'utf8');
    }
    
    const channels = await M3UParser.parseM3U(content);
    const categories = M3UParser.extractCategories(channels);
    
    console.log(`✅ تم تحميل ${channels.length} قناة و ${categories.length} فئة`);
    return { channels, categories };
  } catch (error) {
    console.error('❌ خطأ في جلب/تحليل M3U:', error.message);
    return { channels: [], categories: [] };
  }
}

// تحديث الذاكرة المؤقتة
async function updateCache() {
  const now = Date.now();
  if (now - lastCacheUpdate < CONFIG.cache_duration * 60 * 1000) {
    return; // لا تزال البيانات صالحة
  }
  
  console.log('🔄 تحديث ذاكرة القنوات...');
  const { channels, categories } = await fetchAndParseM3U();
  if (channels.length > 0) {
    cachedChannels = channels;
    cachedCategories = categories;
    lastCacheUpdate = now;
  }
}

// ================== دوال مساعدة ==================
function authenticate(req) {
  const { username, password } = req.query;
  return username === CONFIG.username && password === CONFIG.password;
}

function getServerUrl(req) {
  if (CONFIG.server_url) return CONFIG.server_url;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

function formatLiveStream(channel, serverUrl) {
  // تقسيم المجموعة الأولى كمعرّف فئة
  const primaryGroup = channel.group_title.split(';')[0].trim();
  const category = cachedCategories.find(c => c.category_name === primaryGroup);
  
  return {
    num: channel.stream_id,
    name: channel.name,
    stream_type: 'live',
    stream_id: channel.stream_id,
    stream_icon: channel.tvg_logo,
    epg_channel_id: channel.tvg_id || null,
    added: channel.added,
    category_id: category ? category.category_id.toString() : '0',
    custom_sid: channel.custom_sid,
    tv_archive: channel.tv_archive,
    direct_source: '',
    tv_archive_duration: 0,
    // رابط البث للتطبيق
    stream_url: `${serverUrl}/live/${CONFIG.username}/${CONFIG.password}/${channel.stream_id}.m3u8`
  };
}

// ================== نقاط نهاية API الرئيسية ==================

// ✅ player_api.php - النقطة المركزية لـ Xtream
app.get(['/player_api.php', '/api', '/'], async (req, res) => {
  await updateCache();
  
  const { action, username, password, category_id } = req.query;
  
  // 🔐 التحقق من المصادقة
  if (!authenticate(req)) {
    return res.json({ user_info: { auth: 0, message: "Invalid credentials" } });
  }
  
  const serverUrl = getServerUrl(req);
  
  // 📊 معلومات المستخدم الأساسية
  const baseResponse = {
    user_info: {
      auth: 1,
      username: CONFIG.username,
      password: CONFIG.password,
      message: "OK",
      status: "Active",
      exp_date: CONFIG.expiration_date,
      is_trial: "0",
      active_cons: "0",
      max_connections: CONFIG.max_connections,
      allowed_output_formats: ["m3u8", "ts", "mp4"]
    },
    server_info: {
      url: serverUrl,
      server_name: CONFIG.server_name,
      server_protocol: serverUrl.split('://')[0],
      https_port: "443",
      http_port: "80",
      rtmp_port: "1935",
      timezone: "UTC",
      timestamp_now: Math.floor(Date.now() / 1000),
      process: "1"
    }
  };
  
  // 🔄 معالجة بارامتر action
  switch (action) {
    
    case 'get_live_categories':
      return res.json(cachedCategories);
    
    case 'get_live_streams': {
      let streams = cachedChannels;
      if (category_id) {
        const cat = cachedCategories.find(c => c.category_id.toString() === category_id);
        if (cat) {
          streams = streams.filter(ch => 
            ch.group_title.split(';').map(g => g.trim()).includes(cat.category_name)
          );
        }
      }
      return res.json(streams.map(ch => formatLiveStream(ch, serverUrl)));
    }
    
    case 'get_vod_categories':
    case 'get_series_categories':
      return res.json([]); // لا يوجد VOD/Series في هذا الإصدار
    
    case 'get_vod_streams':
    case 'get_series':
      return res.json([]);
    
    case 'get_series_info':
      return res.json({ error: "Series not supported" });
    
    case 'get_short_epg': {
      const streamId = req.query.stream_id;
      const channel = cachedChannels.find(c => c.stream_id === streamId);
      return res.json({
        epg_listings: channel ? [{
          id: "1",
          title: channel.name,
          lang: "ar",
          start: Math.floor(Date.now() / 1000),
          end: Math.floor(Date.now() / 1000) + 3600,
          description: `بث مباشر: ${channel.name}`,
          channel_id: streamId
        }] : []
      });
    }
    
    case 'get_categories':
      return res.json({
        live: cachedCategories,
        vod: [],
        series: []
      });
    
    default:
      // الاستجابة الافتراضية
      return res.json({
        ...baseResponse,
        categories: cachedCategories.slice(0, 20),
        live_streams: cachedChannels.slice(0, 20).map(ch => formatLiveStream(ch, serverUrl))
      });
  }
});

// ================== نقاط نهاية للبث الفعلي ==================

// 🔴 بث القنوات الحية مع دعم الهيدرز المخصصة
app.get('/live/:user/:pass/:streamId.:ext?', async (req, res) => {
  const { user, pass, streamId, ext = 'm3u8' } = req.params;
  
  if (user !== CONFIG.username || pass !== CONFIG.password) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  
  await updateCache();
  const channel = cachedChannels.find(c => c.stream_id === streamId);
  
  if (!channel) {
    return res.status(404).json({ error: "Channel not found", available: cachedChannels.map(c => c.stream_id) });
  }
  
  try {
    // بناء الهيدرز المطلوبة
    const headers = {
      'User-Agent': channel.user_agent || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': channel.referrer || req.headers['referer'] || '*',
      'Origin': req.headers['origin'] || '*',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Icy-MetaData': '1'
    };
    
    // إزالة الهيدرز الفارغة
    Object.keys(headers).forEach(key => {
      if (!headers[key]) delete headers[key];
    });
    
    // للبث المباشر: إعادة توجيه ذكية
    if (ext === 'm3u8' || ext === 'ts' || ext === 'mpd') {
      // إضافة الهيدرز كرابط معاد توجيهه (للتطبيقات التي تدعمها)
      // أو استخدام بروكسي كامل للقنوات الحساسة
      if (channel.user_agent || channel.referrer) {
        // بروكسي كامل للقنوات التي تتطلب هيدرز
        const response = await axios.get(channel.stream_url, {
          headers,
          responseType: 'stream',
          timeout: 30000,
          maxRedirects: 5
        });
        
        // نسخ الهيدرز المناسبة
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/x-mpegURL');
        res.setHeader('Cache-Control', 'no-cache');
        
        response.data.pipe(res);
      } else {
        // إعادة توجيه مباشرة للقنوات البسيطة (توفير للنطاق)
        return res.redirect(302, channel.stream_url);
      }
    } else {
      // للروابط الأخرى
      return res.redirect(302, channel.stream_url);
    }
    
  } catch (error) {
    console.error(`❌ Stream error for ${streamId}:`, error.message);
    
    // محاولة إعادة توجيه كبديل أخير
    if (error.response?.status !== 403) {
      return res.redirect(302, channel.stream_url);
    }
    
    res.status(502).json({ 
      error: "Failed to fetch stream", 
      channel: channel.name,
      details: error.message 
    });
  }
});

// ================== نقاط نهاية إضافية ==================

// 📄 ملف M3U للتطبيقات البسيطة
app.get('/get.php', async (req, res) => {
  await updateCache();
  const { username, password, type = 'm3u_plus' } = req.query;
  
  if (!authenticate(req)) {
    return res.status(403).send('# Authentication failed');
  }
  
  const serverUrl = getServerUrl(req);
  let output = `#EXTM3U x-tvg-url="${serverUrl}/epg.xml"\n`;
  
  cachedChannels.forEach(channel => {
    const extInf = `#EXTINF:-1`;
    const attrs = [
      channel.tvg_id ? `tvg-id="${channel.tvg_id}"` : '',
      `tvg-name="${channel.name}"`,
      channel.tvg_logo ? `tvg-logo="${channel.tvg_logo}"` : '',
      `group-title="${channel.group_title}"`,
      channel.user_agent ? `user-agent="${channel.user_agent}"` : '',
      channel.referrer ? `http-referrer="${channel.referrer}"` : ''
    ].filter(a => a).join(' ');
    
    output += `${extInf} ${attrs},${channel.name}\n`;
    
    // إضافة خيارات VLC إذا لزم
    if (channel.user_agent) {
      output += `#EXTVLCOPT:http-user-agent=${channel.user_agent}\n`;
    }
    if (channel.referrer) {
      output += `#EXTVLCOPT:http-referrer=${channel.referrer}\n`;
    }
    
    output += `${serverUrl}/live/${username}/${password}/${channel.stream_id}.m3u8\n`;
  });
  
  res.set('Content-Type', 'application/x-mpegURL');
  res.set('Content-Disposition', `attachment; filename="xtream_playlist.m3u8"`);
  res.send(output);
});

// 📰 ملف EPG بسيط (XMLTV)
app.get('/epg.xml', async (req, res) => {
  await updateCache();
  res.set('Content-Type', 'application/xml');
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Xtream M3U Proxy" generator-info-url="${getServerUrl(req)}">\n`;
  
  cachedChannels.slice(0, 100).forEach(channel => {
    if (channel.tvg_id) {
      xml += `  <channel id="${channel.tvg_id}">\n`;
      xml += `    <display-name lang="ar">${channel.name}</display-name>\n`;
      if (channel.tvg_logo) {
        xml += `    <icon src="${channel.tvg_logo}"/>\n`;
      }
      xml += `  </channel>\n`;
    }
  });
  
  // إضافة برامج تجريبية
  const now = Math.floor(Date.now() / 1000);
  cachedChannels.slice(0, 10).forEach((channel, idx) => {
    if (channel.tvg_id) {
      xml += `  <programme start="${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]} +0000" stop="${new Date(Date.now() + 3600000).toISOString().replace(/[-:]/g, '').split('.')[0]} +0000" channel="${channel.tvg_id}">\n`;
      xml += `    <title lang="ar">بث مباشر - ${channel.name}</title>\n`;
      xml += `    <desc lang="ar">قناة ${channel.name} - بث حي</desc>\n`;
      xml += `    <category lang="ar">${channel.group_title}</category>\n`;
      xml += `  </programme>\n`;
    }
  });
  
  xml += '</tv>';
  res.send(xml);
});

// 🏠 صفحة حالة الخادم
app.get('/status', async (req, res) => {
  await updateCache();
  res.json({
    status: "online",
    server: CONFIG.server_name,
    uptime: process.uptime(),
    cache: {
      channels: cachedChannels.length,
      categories: cachedCategories.length,
      last_update: new Date(lastCacheUpdate).toISOString(),
      next_update: new Date(lastCacheUpdate + CONFIG.cache_duration * 60 * 1000).toISOString()
    },
    config: {
      m3u_source: CONFIG.m3u_url,
      cache_minutes: CONFIG.cache_duration
    },
    timestamp: new Date().toISOString()
  });
});

// 🔄 نقطة لتحديث الذاكرة المؤقتة يدوياً
app.post('/refresh-cache', async (req, res) => {
  console.log('🔄 تحديث يدوي للذاكرة المؤقتة...');
  const { channels, categories } = await fetchAndParseM3U();
  if (channels.length > 0) {
    cachedChannels = channels;
    cachedCategories = categories;
    lastCacheUpdate = Date.now();
    res.json({ success: true, channels: channels.length, categories: categories.length });
  } else {
    res.status(500).json({ success: false, error: "Failed to fetch channels" });
  }
});

// ================== معالجة الأخطاء ==================
app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found", 
    available: [
      "/player_api.php?action=get_live_streams&username=...&password=...",
      "/player_api.php?action=get_live_categories",
      "/live/{user}/{pass}/{streamId}.m3u8",
      "/get.php?username=...&password=...&type=m3u_plus",
      "/status",
      "/epg.xml"
    ]
  });
});

app.use((err, req, res, next) => {
  console.error('🔥 Server error:', err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ================== تشغيل الخادم ==================
async function startServer() {
  // تحميل أولي للقنوات
  console.log('🚀 بدء تشغيل Xtream IPTV Server...');
  await updateCache();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📡 API: /player_api.php`);
    console.log(`🔗 M3U: /get.php?username=${CONFIG.username}&password=${CONFIG.password}`);
    console.log(`📊 Status: /status`);
    console.log(`🔄 Cache: ${CONFIG.cache_duration} دقائق`);
  });
}

startServer();

// ================== إشارات الإغلاق ==================
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM - إغلاق الخادم...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT - إغلاق الخادم...');
  process.exit(0);
});

module.exports = app;
