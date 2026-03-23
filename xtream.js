// xtream.js - Xtream IPTV كامل
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// --- إعداد المستخدم ---
const user = { username: "zaki", password: "1234" };

// --- مصفوفة القنوات ---
let streams = [];

// --- رابط M3U من GitHub (Raw URL) ---
const M3U_URL = "https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/main/playlist.m3u";

// --- دالة تحميل القنوات ---
async function loadM3U() {
  try {
    const res = await axios.get(M3U_URL);
    const lines = res.data.split("\n");

    let name = "";
    let id = 1;
    streams = [];

    for (let line of lines) {
      if (line.startsWith("#EXTINF")) {
        name = line.split(",").pop().trim();
      } else if (line.startsWith("http")) {
        streams.push({
          name,
          stream_id: id++,
          stream_url: line.trim()
        });
      }
    }

    console.log("Channels loaded:", streams.length);
  } catch (e) {
    console.log("Error loading M3U:", e.message);
  }
}

// --- تحميل القنوات عند التشغيل ---
loadM3U();

// --- تحديث كل 30 دقيقة ---
setInterval(loadM3U, 1000 * 60 * 30);

// --- Xtream API endpoint ---
app.get("/player_api.php", (req, res) => {
  const { username, password } = req.query;

  if (username !== user.username || password !== user.password) {
    return res.json({ user_info: { auth: 0 } });
  }

  res.json({
    user_info: {
      auth: 1,
      username,
      status: "Active",
      expiration_date: "2099-12-31"
    },
    server_info: {
      url: req.hostname,
      server_name: "My Xtream",
      server_protocol: "http"
    },
    live_streams: streams.map(s => ({
      name: s.name,
      stream_id: s.stream_id,
      stream_type: "live",
      stream_icon: "",      // ضع رابط شعار القناة إذا عندك
      category_id: 1,       // يمكن تعديل التصنيف حسب الحاجة
      epg_channel_id: "",   // لاحقًا يمكن ربط EPG
      stream_url: s.stream_url
    }))
  });
});

// --- endpoint لتجربة القنوات مباشرة (اختياري) ---
app.get("/channels", (req, res) => {
  res.json(streams);
});

// --- تشغيل قناة حسب stream_id ---
app.get("/live/:u/:p/:id.m3u8", (req, res) => {
  const { u, p, id } = req.params;

  if (u !== user.username || p !== user.password) {
    return res.sendStatus(403);
  }

  const stream = streams.find(s => s.stream_id == id);
  if (!stream) return res.sendStatus(404);

  res.redirect(stream.stream_url);
});

// --- تشغيل السيرفر ---
app.listen(PORT, () => console.log(`Xtream IPTV Server running on port ${PORT}`));const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

let streams = [];

// تحميل ملف M3U
async function loadM3U() {
  try {
    const res = await axios.get("https://raw.githubusercontent.com/zakariasemaoui101-glitch/xtream-iptv/refs/heads/main/playlist.m3u");
    const lines = res.data.split("\n");

    let name = "";
    let id = 1;
    streams = [];

    for (let line of lines) {
      if (line.startsWith("#EXTINF")) {
        name = line.split(",").pop();
      } else if (line.startsWith("http")) {
        streams.push({
          name,
          stream_id: id++,
          stream_url: line.trim()
        });
      }
    }

    console.log("Channels loaded:", streams.length);
  } catch (e) {
    console.log("Error:", e.message);
  }
}

// تحميل عند التشغيل
loadM3U();

// تحديث كل 30 دقيقة
setInterval(loadM3U, 1000 * 60 * 30);

// مستخدم بسيط
const user = { username: "zaki", password: "1234" };

// API مثل Xtream
app.get("/player_api.php", (req, res) => {
  const { username, password } = req.query;

  if (username !== user.username || password !== user.password) {
    return res.json({ user_info: { auth: 0 } });
  }

  res.json({
    user_info: { auth: 1, username },
    server_info: { url: req.hostname }
  });
});

// قائمة القنوات
app.get("/channels", (req, res) => {
  res.json(streams);
});

// تشغيل القناة
app.get("/live/:u/:p/:id.m3u8", (req, res) => {
  const { u, p, id } = req.params;

  if (u !== user.username || p !== user.password) {
    return res.sendStatus(403);
  }

  const stream = streams.find(s => s.stream_id == id);
  if (!stream) return res.sendStatus(404);

  res.redirect(stream.stream_url);
});
{
  "user_info": {
    "auth": 1,
    "username": "zaki",
    "status": "Active",
    "expiration_date": "2099-12-31"
  },
  "server_info": {
    "url": "xtream-iptv.onrender.com",
    "server_name": "My Xtream"
  },
  "live_streams": [
    {
      "name": "2M (1080p)",
      "stream_id": 1,
      "stream_type": "live",
      "stream_icon": "",
      "category_id": 1,
      "stream_url": "http://5.253.46.190:8000/play/a0e9/index.m3u8"
    },
    {
      "name": "2M Monde +1",
      "stream_id": 2,
      "stream_type": "live",
      "stream_icon": "",
      "category_id": 1,
      "stream_url": "https://d2qh3gh0k5vp3v.cloudfront.net/.../2M_ES.m3u8"
    }
  ]
}
app.listen(PORT, () => console.log("Server running"));
