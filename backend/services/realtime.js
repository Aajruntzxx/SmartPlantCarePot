// Hub SSE: browser menerima data real-time dari backend (bukan langsung dari broker),
// sehingga kredensial MQTT tidak pernah sampai ke frontend dan akses tetap per pemilik.
const subscribers = new Map(); // deviceId -> Set<res>

function subscribe(deviceId, res) {
  if (!subscribers.has(deviceId)) subscribers.set(deviceId, new Set());
  subscribers.get(deviceId).add(res);
  res.on("close", () => {
    const set = subscribers.get(deviceId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) subscribers.delete(deviceId);
  });
}

function emit(deviceId, event, data) {
  const set = subscribers.get(deviceId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

// Menjaga koneksi SSE tetap hidup melewati proxy/idle timeout.
setInterval(() => {
  for (const set of subscribers.values()) {
    for (const res of set) res.write(": ping\n\n");
  }
}, 25000).unref();

module.exports = { subscribe, emit };
