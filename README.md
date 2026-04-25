# 📦 Baktime

> **The "Upptime" for Database Backups.** > Orchestrate multiple MySQL & PostgreSQL backups to S3/R2 using GitHub Actions.

Baktime is a lightweight, configuration-first backup solution. Define your databases in a YAML file, and GitHub Actions handles the rest: parallel dumping, secure uploading to Cloudflare R2/S3, and automated status reporting.

---

## 🛠️ Configuration (`.baktime.yml`)

Centralize your backup management. You can define multiple sources of the same or different types. Baktime will automatically spawn a parallel job for each entry.

```yaml
# .baktime.yml
databases:
  - name: main-app-mysql
    type: mysql
    host: db.example.com
    port: 3306
    user: admin
    # The name of the secret stored in GitHub Actions Secrets
    password_secret: DB_PROD_PASSWORD 
    bucket: production-backups

  - name: analytics-postgres
    type: postgres
    host: pg.analytics.io
    port: 5432
    user: pg_user
    password_secret: DB_ANALYTICS_PASSWORD
    bucket: analytics-backups

notifications:
  discord: true
  slack: false
```

---

## 🚀 How it Works

Baktime utilizes the **GitHub Actions Matrix Strategy**. This allows the workflow to scale dynamically based on your configuration file.

1. **Parser:** A setup job reads `.baktime.yml` and generates a JSON matrix.
2. **Backup Workers:** GitHub spins up multiple runners simultaneously (one for each database).
3. **Stream to S3:** Data is dumped and streamed directly to your S3-compatible storage (e.g., Cloudflare R2) to avoid filling up runner disk space.
4. **Status Update:** The results are committed to the `gh-pages` branch to update your dashboard.

---

## ⚙️ Setup & Secrets

### 1. Global S3 Credentials
Add these to **Settings > Secrets and variables > Actions** in your repository:
* `S3_ACCESS_KEY`: Your S3/R2 Access Key ID.
* `S3_SECRET_KEY`: Your S3/R2 Secret Access Key.
* `S3_ENDPOINT`: Your S3 endpoint (e.g., `https://<id>.r2.cloudflarestorage.com`).

### 2. Database Passwords
For each database in your YAML, add a secret with the name you specified in `password_secret`.
* *Example:* If you set `password_secret: MY_DB_PASS`, create a GitHub secret named `MY_DB_PASS`.

---

## ✨ Features

- **Multi-source:** Supports unlimited MySQL & PostgreSQL instances in one repo.
- **Parallelism:** Matrix Strategy ensures fast, concurrent execution.
- **S3-Compatible:** Tested with Cloudflare R2, AWS S3, Wasabi, and Backblaze B2.
- **Alerts:** Get Discord or Slack pings the moment a backup fails.
- **Serverless:** $0/month cost using GitHub's free tier for public repositories.

---

## 📊 Status Page
Your status page is automatically generated and hosted on GitHub Pages. It visualizes:
- **Uptime of Backups:** 30-day success/failure history.
- **Metadata:** Last backup size and timestamp.
- **Logs:** Direct links to GitHub Action logs for failed runs.

---
*Inspired by the architecture of Upptime. Built for reliability and simplicity.*
