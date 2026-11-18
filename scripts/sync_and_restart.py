# scripts/sync_and_restart.py
import os
import sys
from pathlib import Path
import paramiko

SSH_HOST = "13.48.58.210"
SSH_USER = "ubuntu"
SSH_KEY = r"C:\Users\moham\Downloads\detective-bot-ec2.pem"
REMOTE_DIR = "/opt/detective-bot"
LOCAL_DIR = r"C:\Users\moham\Downloads\detective-bot-merged\proj"

FILES_TO_SYNC = [
    "services/gameManager.js",
    "services/inAppChat.js",
    "services/spyImageServer.js",
    "services/messengerFacebook.js",
    "database.js",
    "python/dashboard/app.py",
    "python/dashboard/templates/index.html",
]

def main():
    print(f"Connecting to AWS EC2: {SSH_HOST}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SSH_HOST, username=SSH_USER, key_filename=SSH_KEY, timeout=15)
        print("Connected successfully via SSH!")

        sftp = client.open_sftp()
        for rel_path in FILES_TO_SYNC:
            local_path = os.path.join(LOCAL_DIR, rel_path)
            remote_path = f"{REMOTE_DIR}/{rel_path}"
            if os.path.exists(local_path):
                # Ensure remote dir exists
                remote_parent = os.path.dirname(remote_path)
                client.exec_command(f"sudo mkdir -p {remote_parent} && sudo chown -R ubuntu:ubuntu {remote_parent}")
                print(f"Uploading {rel_path} -> {remote_path}...")
                sftp.put(local_path, remote_path)
        sftp.close()

        print("\nRestarting services...")
        client.exec_command("sudo systemctl restart detective-bot && sudo systemctl restart detective-bot-dashboard")
        
        stdin, stdout, stderr = client.exec_command("sudo systemctl status detective-bot-dashboard --no-pager -n 5")
        print("\nDashboard Status:")
        print(stdout.read().decode())

        print("\nSUCCESS! All files synced and live on server!")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        client.close()

if __name__ == "__main__":
    main()
