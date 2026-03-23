// xtream.js - XTream IPTV Server with Advanced M3U Parser
// ✅ متوافق مع ملف M3U الخاص بك + تطبيقات Xtream

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// ================== إعدادات أساسية ==================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 إعدادات المستخدم
const CONFIG = {
  username: process.env.XTREAM_USER || 'zaki',
  password: process.env.XTREAM_PASS || '1234',
  server_name: 'My Xtream Server',
  m3u_url: process.env.M3U_URL || 'https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/main/playlist.m3u'
};

// 🗄️ ذاكرة التخزين المؤقت
let cachedData = { channels: [], categories: [], lastUpdate: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 دقيقة

// ================== 🔍 محلل M3U المتقدم ==================
function parseM3U(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);
  const channels = [];
  const categories = new Map();
  let current = null;
  let vlcOpts = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // تخطي الرأس
    if (line === '#EXTM3U') continue;

    // معالجة خيارات VLC (تأتي بعد #EXTINF)
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) {
        vlcOpts['user-agent'] = opt.split('=')[1];
      } else if (opt.startsWith('http-referrer=')) {
        vlcOpts['referrer'] = opt.split('=')[1];
      }
      continue;
    }

    // معالجة سطر القناة #EXTINF
    if (line.startsWith('#EXTINF:')) {
      // إعادة تعيين خيارات VLC للقناة الجديدة
      vlcOpts = {};
      
      // 1️⃣ استخراج الاسم (بعد آخر فاصلة)
      const nameMatch = line.match(/,([^,]+)$/);
      const name = nameMatch ? nameMatch[1].trim() : 'Unknown';

      // 2️⃣ استخراج جميع السمات (قبل وبعد الاسم)
      const attributes = {};
      
      // سمات قبل الاسم: key="value" أو key='value'
      const attrRegex = /(\w+(?:-\w+)*)="([^"]*)"|(\w+(?:-\w+)*)='([^']*)'/g;
      let match;
      while ((match = attrRegex.exec(line)) !== null) {
        const key = match[1] || match[3];
        const value = match[2] || match[4];
        if (key && value) attributes[key] = value;
      }
      
      // سمات بعد الاسم (مثل: user-agent="..." بعد الفاصلة الأخيرة)
      const nameIndex = line.lastIndexOf(',');
      if (nameIndex !== -1) {
        const afterName = line.substring(nameIndex + 1);
        const postAttrRegex = /(\w+(?:-\w+)*)="([^"]*)"|(\w+(?:-\w+)*)='([^']*)'/g;
        while ((match = postAttrRegex.exec(afterName)) !== null) {
          const key = match[1] || match[3];
          const value = match[2] || match[4];
          if (key && value && !attributes[key]) {
            attributes[key] = value;
          }
        }
      }

      // 3️⃣ بناء كائن القناة
      const groupTitle = attributes['group-title'] || 'Uncategorized';
      
      current = {
        stream_id: '', // سيتم توليده لاحقاً
        name: name,
        tvg_id: attributes['tvg-id'] || '',
        tvg_logo: attributes['tvg-logo'] || '',
        group_title: groupTitle,
        user_agent: attributes['user-agent'] || '',
        referrer: attributes['referrer'] || '',
        stream_url: '',
        added: Math.floor(Date.now() / 1000).toString(),
        tv_archive: 0
      };

      // 4️⃣ إضافة الفئات (يدعم تعدد الفئات بـ ;)
      const groups = groupTitle.split(';').map(g => g.trim()).filter(g => g);
      groups.forEach(group => {
        if (!categories.has(group)) {
          categories.set(group, {
            category_id: categories.size + 1,
            category_name: group,
            parent_id: 0
          });
        }
      });
      
      continue;
    }

    // معالجة رابط البث (أي سطر يبدأ بـ http ولا يبدأ بـ #)
    if (current && !line.startsWith('#') && line.startsWith('http')) {
      current.stream_url = line.trim();
      
      // توليد stream_id فريد بناءً على الرابط
      current.stream_id = crypto
        .createHash('md5')
        .update(current.stream_url)
        .digest('hex')
        .substring(0, 12);
      
      // دمج خيارات VLC إذا وجدت
      if (vlcOpts['user-agent'] && !current.user_agent) {
        current.user_agent = vlcOpts['user-agent'];
      }
      if (vlcOpts['referrer'] && !current.referrer) {
        current.referrer = vlcOpts['referrer'];
      }
      
      channels.push({ ...current });
      current = null;
    }
  }

  console.log(`📊 Parsed: ${channels.length} channels, ${categories.size} categories`);
  return { 
    channels, 
    categories: Array.from(categories.values()) 
  };
}

// ================== 📥 جلب وتحليل M3U ==================
async function fetchChannels() {
  try {
    const now = Date.now();
    
    // إرجاع البيانات المخزنة إذا لم تنتهِ مدة الصلاحية
    if (cachedData.channels.length > 0 && now - cachedData.lastUpdate < CACHE_TTL) {
      return cachedData;
    }
    
    console.log('🔄 Fetching M3U from:', CONFIG.m3u_url);
    
    const { data } = await axios.get(CONFIG.m3u_url, {
      timeout: 30000,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      // قبول أي نوع محتوى
      responseType: 'text'
    });
    
    if (!data || !data.includes('#EXTM3U')) {
      throw new Error('Invalid M3U content');
    }
    
    const { channels, categories } = parseM3U(data);
    
    if (channels.length === 0) {
      console.warn('⚠️ No channels parsed - check M3U format');
    }
    
    cachedData = { channels, categories, lastUpdate: now };
    return cachedData;
    
  } catch (err) {
    console.error('❌ M3U fetch/parse error:', err.message);
    // إرجاع البيانات القديمة إذا توفرت
    return cachedData.channels.length > 0 ? cachedData : { channels: [], categories: [], lastUpdate: now };
  }
}

// ================== 🔐 دوال مساعدة ==================
function auth(req) {
  const { username, password } = req.query;
  return username === CONFIG.username && password === CONFIG.password;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function getCategoryIds(groupTitle, categories) {
  const groups = groupTitle.split(';').map(g => g.trim());
  const ids = [];
  groups.forEach(g => {
    const cat = categories.find(c => c.category_name === g);
    if (cat) ids.push(cat.category_id.toString());
  });
  return ids.length > 0 ? ids[0] : '0'; // إرجاع أول فئة كمعرف رئيسي
}

// ================== 🎯 نقاط النهاية الرئيسية ==================

// ✅ player_api.php - متوافق مع Xtream Apps
app.get(['/player_api.php', '/api', '/'], async (req, res) => {
  const { action, category_id } = req.query;
  
  if (!auth(req)) {
    return res.json({ user_info: { auth: 0, message: 'Invalid credentials' } });
  }
  
  const data = await fetchChannels();
  const baseUrl = getBaseUrl(req);
  const { channels, categories } = data;
  
  const baseInfo = {
    user_info: {
      auth: 1,
      username: CONFIG.username,
      password: CONFIG.password,
      message: 'OK',
      status: 'Active',
      exp_date: '2099-12-31',
      is_trial: '0',
      active_cons: '0',
      max_connections: '1',
      allowed_output_formats: ['m3u8', 'ts', 'mp4']
    },
    server_info: {
      url: baseUrl,
      server_name: CONFIG.server_name,
      server_protocol: baseUrl.split('://')[0],
      https_port: '443',
      http_port: '80',
      rtmp_port: '1935',
      timezone: 'UTC',
      timestamp_now: Math.floor(Date.now() / 1000),
      process: '1'
    }
  };
  
  switch (action) {
    
    case 'get_live_categories':
      return res.json(categories);
    
    case 'get_live_streams': {
      let filtered = channels;
      
      // تصفية حسب الفئة إذا طُلب
      if (category_id) {
        const cat = categories.find(c => c.category_id.toString() === category_id);
        if (cat) {
          filtered = channels.filter(ch => 
            ch.group_title.split(';').map(g => g.trim()).includes(cat.category_name)
          );
        }
      }
      
      return res.json(filtered.map(ch => ({
        num: ch.stream_id,
        name: ch.name,
        stream_type: 'live',
        stream_id: ch.stream_id,
        stream_icon: ch.tvg_logo,
        epg_channel_id: ch.tvg_id || null,
        added: ch.added,
        category_id: getCategoryIds(ch.group_title, categories),
        custom_sid: '',
        tv_archive: ch.tv_archive,
        direct_source: '',
        tv_archive_duration: 0,
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
    
    case 'get_categories':
      return res.json({ live: categories, vod: [], series: [] });
    
    default:
      // الاستجابة الافتراضية
      return res.json({
        ...baseInfo,
        categories: categories.slice(0, 20),
        live_streams: channels.slice(0, 20).map(ch => ({
          num: ch.stream_id,
          name: ch.name,
          stream_type: 'live',
          stream_id: ch.stream_id,
          stream_icon: ch.tvg_logo,
          category_id: getCategoryIds(ch.group_title, categories),
          stream_url: `${baseUrl}/live/${CONFIG.username}/${CONFIG.password}/${ch.stream_id}.m3u8`
        }))
      });
  }
});

// 🔴 نقطة البث المباشر مع دعم الهيدرز المخصصة
app.get('/live/:user/:pass/:streamId.:ext?', async (req, res) => {
  const { user, pass, streamId, ext = 'm3u8' } = req.params;
  
  if (user !== CONFIG.username || pass !== CONFIG.password) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const data = await fetchChannels();
  const channel = data.channels.find(c => c.stream_id === streamId);
  
  if (!channel) {
    return res.status(404).json({ 
      error: 'Channel not found',
      hint: 'Use /status to see available channels'
    });
  }
  
  try {
    // بناء الهيدرز المطلوبة
    const headers = {};
    
    if (channel.user_agent) {
      headers['User-Agent'] = channel.user_agent;
    } else if (req.headers['user-agent']) {
      headers['User-Agent'] = req.headers['user-agent'];
    }
    
    if (channel.referrer) {
      headers['Referer'] = channel.referrer;
    } else if (req.headers['referer']) {
      headers['Referer'] = req.headers['referer'];
    }
    
    headers['Accept'] = '*/*';
    headers['Connection'] = 'keep-alive';
    
    // للقنوات التي لا تحتاج هيدرز خاصة: إعادة توجيه مباشرة (توفير للنطاق)
    if (!channel.user_agent && !channel.referrer) {
      return res.redirect(302, channel.stream_url);
    }
    
    // للقنوات التي تحتاج هيدرز: بروكسي كامل
    const response = await axios.get(channel.stream_url, {
      headers,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5
    });
    
    // نسخ الهيدرز المناسبة من الاستجابة الأصلية
    const contentType = response.headers['content-type'] || 'application/x-mpegURL';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    // تمرير البيانات
    response.data.pipe(res);
    
  } catch (error) {
    console.error(`❌ Stream error for ${streamId}:`, error.message);
    
    // محاولة إعادة توجيه كبديل أخير
    if (!channel.user_agent && !channel.referrer) {
      return res.redirect(302, channel.stream_url);
    }
    
    res.status(502).json({ 
      error: 'Failed to fetch stream',
      channel: channel.name,
      details: error.message 
    });
  }
});

// 📄 ملف M3U للتطبيقات البسيطة
app.get('/get.php', async (req, res) => {
  if (!auth(req)) {
    return res.status(403).send('# Authentication failed');
  }
  
  const data = await fetchChannels();
  const baseUrl = getBaseUrl(req);
  const { channels } = data;
  
  let output = `#EXTM3U x-tvg-url="${baseUrl}/epg.xml"\n`;
  
  channels.forEach(ch => {
    // بناء سطر #EXTINF مع جميع السمات
    const attrs = [
      ch.tvg_id ? `tvg-id="${ch.tvg_id}"` : '',
      `tvg-name="${ch.name}"`,
      ch.tvg_logo ? `tvg-logo="${ch.tvg_logo}"` : '',
      `group-title="${ch.group_title}"`,
      ch.user_agent ? `user-agent="${ch.user_agent}"` : '',
      ch.referrer ? `referrer="${ch.referrer}"` : ''
    ].filter(a => a).join(' ');
    
    output += `#EXTINF:-1 ${attrs},${ch.name}\n`;
    
    // إضافة خيارات VLC إذا لزم
    if (ch.user_agent) {
      output += `#EXTVLCOPT:http-user-agent=${ch.user_agent}\n`;
    }
    if (ch.referrer) {
      output += `#EXTVLCOPT:http-referrer=${ch.referrer}\n`;
    }
    
    // رابط البث عبر البروكسي
    output += `${baseUrl}/live/${CONFIG.username}/${CONFIG.password}/${ch.stream_id}.m3u8\n`;
  });
  
  res.set('Content-Type', 'application/x-mpegURL');
  res.set('Content-Disposition', 'attachment; filename="xtream_playlist.m3u8"');
  res.send(output);
});

// 📰 ملف EPG بسيط (XMLTV)
app.get('/epg.xml', async (req, res) => {
  const data = await fetchChannels();
  res.set('Content-Type', 'application/xml');
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Xtream M3U Proxy">\n`;
  
  // إضافة القنوات
  data.channels.slice(0, 100).forEach(ch => {
    if (ch.tvg_id) {
      xml += `  <channel id="${ch.tvg_id}">\n`;
      xml += `    <display-name lang="ar">${ch.name}</display-name>\n`;
      if (ch.tvg_logo) xml += `    <icon src="${ch.tvg_logo}"/>\n`;
      xml += `  </channel>\n`;
    }
  });
  
  // إضافة برامج تجريبية
  const now = new Date();
  const later = new Date(now.getTime() + 3600000);
  const timeFormat = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + ' +0000';
  
  data.channels.slice(0, 10).forEach(ch => {
    if (ch.tvg_id) {
      xml += `  <programme start="${timeFormat(now)}" stop="${timeFormat(later)}" channel="${ch.tvg_id}">\n`;
      xml += `    <title lang="ar">${ch.name}</title>\n`;
      xml += `    <desc lang="ar">بث مباشر</desc>\n`;
      xml += `    <category lang="ar">${ch.group_title}</category>\n`;
      xml += `  </programme>\n`;
    }
  });
  
  xml += '</tv>';
  res.send(xml);
});

// 🏠 صفحة حالة الخادم
app.get('/status', async (req, res) => {
  const data = await fetchChannels();
  res.json({
    status: 'online',
    server: CONFIG.server_name,
    uptime: process.uptime(),
    cache: {
      channels: data.channels.length,
      categories: data.categories.length,
      last_update: new Date(data.lastUpdate).toISOString(),
      ttl_minutes: CACHE_TTL / 60000
    },
    config: {
      m3u_source: CONFIG.m3u_url,
      username: CONFIG.username
    },
    endpoints: [
      '/player_api.php?username=...&password=...&action=get_live_streams',
      '/get.php?username=...&password=...&type=m3u_plus',
      '/live/{user}/{pass}/{streamId}.m3u8',
      '/epg.xml',
      '/status'
    ]
  });
});

// 🔄 تحديث يدوي للذاكرة المؤقتة
app.post('/refresh-cache', async (req, res) => {
  console.log('🔄 Manual cache refresh requested');
  cachedData = { channels: [], categories: [], lastUpdate: 0 };
  const data = await fetchChannels();
  res.json({ 
    success: true, 
    channels: data.channels.length, 
    categories: data.categories.length 
  });
});

// ================== معالجة الأخطاء ==================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available: [
      '/player_api.php',
      '/get.php',
      '/live/:user/:pass/:id.m3u8',
      '/status',
      '/epg.xml'
    ]
  });
});

app.use((err, req, res, next) => {
  console.error('🔥 Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ================== تشغيل الخادم ==================
async function startServer() {
  console.log('🚀 Starting Xtream IPTV Server...');
  
  // تحميل أولي للقنوات
  await fetchChannels();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API: /player_api.php`);
    console.log(`🔗 M3U: /get.php?username=${CONFIG.username}&password=${CONFIG.password}`);
    console.log(`📊 Status: /status`);
  });
}

startServer();

// إشارات الإغلاق
process.on('SIGTERM', () => { console.log('🛑 SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('🛑 SIGINT'); process.exit(0); });

module.exports = app;
