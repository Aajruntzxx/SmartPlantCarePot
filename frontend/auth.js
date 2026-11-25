/* Logika halaman login & registrasi. */
const form = document.getElementById("authForm");
const errorBox = document.getElementById("authError");
const isRegister = form.dataset.mode === "register";

// Peringatan jika pengguna membuka file HTML langsung tanpa lewat server
if (window.location.protocol === "file:") {
  if (errorBox) {
    errorBox.textContent = "Perhatian: Jangan buka file ini langsung (file:///). Jalankan jalankan_server.bat dan buka http://localhost:3000/login.html di browser.";
    errorBox.hidden = false;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "PotPintar" },
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    throw new Error("Gagal terhubung ke server. Pastikan server Node.js dan MySQL di XAMPP sudah dijalankan (START).");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 500) {
      throw new Error(data.error ? `${data.error} (Pastikan modul MySQL di XAMPP sudah di-START).` : "Terjadi kesalahan server database.");
    }
    throw new Error(data.error || "Terjadi kesalahan.");
  }
  return data;
}

// Jika sudah login, langsung ke dashboard.
fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => { if (r.ok) location.replace("/"); });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const body = { email: form.email.value, password: form.password.value };
    if (isRegister) body.name = form.name.value;
    await api(isRegister ? "/api/auth/register" : "/api/auth/login", body);
    location.replace("/");
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    btn.disabled = false;
  }
});
