const express = require("express");
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

app.listen(PORT, () => console.log("Server running"));
