import os
from pathlib import Path
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, send_file
import paramiko

app = Flask(__name__)
app.secret_key = os.urandom(24)

SSH_HOST = os.getenv("BOT_SSH_HOST", "13.48.58.210")
SSH_USER = os.getenv("BOT_SSH_USER", "ubuntu")
SSH_KEY_PATH = os.getenv(
    "BOT_SSH_KEY",
    str(Path.home() / "Downloads" / "detective-bot-ec2.pem")
)
SERVICE_NAME = "detective-bot"
REMOTE_BOT_DIR = "/opt/detective-bot"

def execute_remote(cmd: str, timeout: int = 15):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=SSH_HOST,
            username=SSH_USER,
            key_filename=SSH_KEY_PATH,
            timeout=timeout
        )
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return True, out, err
    except Exception as e:
        return False, "", str(e)
    finally:
        client.close()

@app.route("/")
def index():
    # فحص حالة البوت
    ok, out, err = execute_remote(f"sudo systemctl status {SERVICE_NAME} --no-pager")
    is_active = "Active: active (running)" in out
    
    # فحص استهلاك الرام والمعالج
    ok_res, res_out, _ = execute_remote("free -m | grep Mem | awk '{print $2, $3}'; uptime | awk -F'load average:' '{print $2}'")
    mem_total, mem_used = "غير معروف", "غير معروف"
    load_avg = ""
    if ok_res and res_out.strip():
        parts = res_out.strip().split("\n")
        if len(parts) >= 1:
            mem_parts = parts[0].split()
            if len(mem_parts) >= 2:
                mem_total, mem_used = mem_parts[0] + " MB", mem_parts[1] + " MB"
        if len(parts) >= 2:
            load_avg = parts[1].strip()

    # جلب آخر 30 سطر من السجلات
    ok_logs, logs_out, _ = execute_remote(f"sudo journalctl -u {SERVICE_NAME} -n 35 --no-pager")

    return render_template(
        "index.html",
        is_active=is_active,
        status_text=out if ok else err,
        logs=logs_out if ok_logs else "تعذر جلب السجلات",
        mem_total=mem_total,
        mem_used=mem_used,
        load_avg=load_avg,
        server_ip=SSH_HOST
    )

@app.route("/restart", methods=["POST"])
def restart_bot():
    ok, out, err = execute_remote(f"sudo systemctl restart {SERVICE_NAME}")
    if ok:
        flash("تمت إعادة تشغيل البوت بنجاح!", "success")
    else:
        flash(f"فشلت إعادة التشغيل: {err}", "danger")
    return redirect(url_for("index"))

@app.route("/upload_appstate", methods=["POST"])
def upload_appstate():
    if "appstate_file" not in request.files:
        flash("لم يتم اختيار أي ملف!", "warning")
        return redirect(url_for("index"))

    file = request.files["appstate_file"]
    if file.filename == "":
        flash("اسم الملف فارغ!", "warning")
        return redirect(url_for("index"))

    content = file.read().decode("utf-8", errors="replace")
    
    # كتابة الملف على السيرفر
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=SSH_HOST, username=SSH_USER, key_filename=SSH_KEY_PATH)
        sftp = client.open_sftp()
        with sftp.open(f"{REMOTE_BOT_DIR}/appstate.json", "w") as remote_file:
            remote_file.write(content)
        sftp.close()
        
        # إعادة تشغيل البوت لتطبيق الجلسة الجديدة
        execute_remote(f"sudo systemctl restart {SERVICE_NAME}")
        flash("تم رفع appstate.json وتحديث الجلسة وإعادة تشغيل البوت بنجاح! 🎉", "success")
    except Exception as e:
        flash(f"حدث خطأ أثناء الرفع: {e}", "danger")
    finally:
        client.close()

    return redirect(url_for("index"))

@app.route("/download_apk")
def download_apk():
    # فحص مسار ملف الـ APK في السيرفر أو مجلد التنزيلات
    candidates = [
        Path(REMOTE_BOT_DIR) / "android_app" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk",
        Path(REMOTE_BOT_DIR) / "detective-bot.apk",
        Path.home() / "Downloads" / "detective-bot.apk",
        Path(__file__).parent.parent.parent / "detective-bot.apk"
    ]
    for p in candidates:
        if p.exists():
            return send_file(str(p), as_attachment=True, download_name="detective-bot.apk")
    return "ملف الـ APK قيد التجهيز على السيرفر...", 404

@app.route("/api/status")
def api_status():
    ok, out, _ = execute_remote(f"systemctl is-active {SERVICE_NAME}")
    return jsonify({
        "status": out.strip() if ok else "unknown",
        "active": out.strip() == "active"
    })

if __name__ == "__main__":
    print(f"🚀 تشغيل لوحة التحكم على: http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
