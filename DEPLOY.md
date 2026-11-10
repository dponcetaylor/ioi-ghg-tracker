# Making the live (production) app on Render — step by step (v11)

Keep your existing free link (the award demo) untouched. This creates a SEPARATE, permanent app.

## A. Put the code on GitHub (new repository)
1. github.com -> "+" (top right) -> **New repository**. Name: `ioi-ghg-tracker`. Choose **Private**. Create.
2. Click **uploading an existing file**. Unzip the v11 zip on your computer, open the `ioi-ghg-app` folder, select EVERYTHING inside it (`data`, `lib`, `public`, `server.js`, `package.json`, `DEPLOY.md`, `README.md`, `.gitignore`) and drag it into the page. (Do not include a `node_modules` folder.)
3. Scroll down -> **Commit changes**.

## B. Create the service on Render
1. render.com -> **New +** -> **Web Service** -> connect GitHub -> pick `ioi-ghg-tracker`.
2. Fill in:
   - Name: `ioi-ghg-tracker`
   - Region: the one closest to you
   - Branch: `main`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - **Instance Type: Starter** (paid, about $7/month; required for a persistent disk)
3. Scroll to **Environment Variables** -> add three:
   - `ADMIN_PASSWORD` = a strong password you choose (this becomes the password of the first account, user name `admin`)
   - `DATA_DIR` = `/var/data`
   - `NODE_VERSION` = `22`
4. Open **Advanced** -> **Add Disk**: Name `data`, Mount Path `/var/data`, Size `1 GB`.
5. Click **Create Web Service**. The first deploy takes a few minutes. When it says "Live", open the link at the top.

## C. First-time setup (inside the app)
1. Log in: user `admin`, password = your `ADMIN_PASSWORD`.
2. **Admin tab -> Staff accounts -> Add a person** for each colleague (username + password; role Staff). Send each person their login.
3. **Admin tab -> Lists & rules**: check the staff, agency and always-homestay lists.
4. **Admin tab -> Remove sample participants** (one time).
5. **Admin tab -> Embark connection**: choose your Embark CSV export, check the preview, **Apply import**. Repeat whenever you want to refresh (safe to repeat). Leave "starting in or after" at 2026 — 2024 and 2025 are already loaded as final figures.
6. **Report tab**: choose a year. 2024 and 2025 show "final" (published figures); 2026 onward are calculated from the data entered.
7. In Render -> Environment, you may now delete `ADMIN_PASSWORD` (the account already exists).

## D. Ongoing
- **Admin -> Download backup** regularly (e.g. monthly) and keep the file somewhere safe.
- To update the app: upload changed files to the GitHub repository; Render redeploys by itself. Your data stays on the disk.
- Forgotten password: Admin -> Reset password.
- Own web address (optional): Render -> Settings -> Custom Domains, e.g. `ghg.ioi.ngo`, then add the record Render shows to your domain's DNS.

## Embark automatic sync (needs Embark's API access)
Add these environment variables in Render and the app refreshes itself every hour:
`EMBARK_API_URL`, `EMBARK_API_TOKEN`, and optionally `EMBARK_API_HEADER`, `EMBARK_ROWS_PATH`, `EMBARK_SYNC_MINUTES`.
